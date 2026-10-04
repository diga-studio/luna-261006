package nodeshield

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// sample 是正常阶段窗口内的一条结果记录。
type sample struct {
	t    time.Time
	fail bool
}

// request 跟踪一次已获准但未结束的请求。
type request struct {
	inst     *instance
	probe    bool
	active   bool
	deadline time.Time // 仅试探请求有效
}

// instance 是单个实例的全部内部状态。
type instance struct {
	id       string
	stage    Stage
	inFlight int

	samples []sample // 仅正常阶段维护，按时间升序

	openUntil time.Time // 熔断截止时刻

	probeActive   bool
	probeDeadline time.Time
	probeReq      *request
}

// Shield 是实例熔断与请求准入库，状态保存在进程内存中。
type Shield struct {
	mu    sync.Mutex
	clock Clock
	last  time.Time

	instances []*instance // 按标识字典序排列
	byID      map[string]*instance

	nextTicket uint64
	reqs       map[uint64]*request
}

// New 创建 Shield，实例池固定，至多 500 个实例，标识唯一且非空。
func New(instanceIDs []string, clock Clock) (*Shield, error) {
	if clock == nil {
		return nil, errors.New("nodeshield: clock is required")
	}
	if len(instanceIDs) == 0 {
		return nil, errors.New("nodeshield: at least one instance is required")
	}
	if len(instanceIDs) > maxInstances {
		return nil, fmt.Errorf("nodeshield: at most %d instances", maxInstances)
	}
	seen := make(map[string]struct{}, len(instanceIDs))
	for _, id := range instanceIDs {
		if id == "" {
			return nil, errors.New("nodeshield: instance id must not be empty")
		}
		if _, dup := seen[id]; dup {
			return nil, fmt.Errorf("nodeshield: duplicate instance id %q", id)
		}
		seen[id] = struct{}{}
	}
	sorted := make([]string, len(instanceIDs))
	copy(sorted, instanceIDs)
	sort.Strings(sorted)

	s := &Shield{
		clock: clock,
		byID:  make(map[string]*instance, len(sorted)),
		reqs:  make(map[uint64]*request),
	}
	for _, id := range sorted {
		inst := &instance{id: id, stage: StageNormal}
		s.instances = append(s.instances, inst)
		s.byID[id] = inst
	}
	return s, nil
}

// now 返回调用方时钟的当前值，并保证内部单调不回退。
func (s *Shield) now() time.Time {
	now := s.clock.Now()
	if now.Before(s.last) {
		return s.last
	}
	s.last = now
	return now
}

// refresh 把实例状态推进到 now：熔断到期进入试探，试探超时重新熔断。
func (s *Shield) refresh(inst *instance, now time.Time) {
	for {
		switch inst.stage {
		case StageOpen:
			if now.Before(inst.openUntil) {
				return
			}
			inst.stage = StageProbing
		case StageProbing:
			if inst.probeActive && !now.Before(inst.probeDeadline) {
				// 试探超时：归还名额，从截止时刻起重新熔断。
				inst.probeActive = false
				if inst.probeReq != nil {
					inst.probeReq.active = false
					inst.probeReq = nil
				}
				inst.inFlight--
				inst.stage = StageOpen
				inst.openUntil = inst.probeDeadline.Add(openDuration)
				continue // 熔断可能也已到期，继续推进
			}
			return
		default:
			return
		}
	}
}

// Admit 申请转发。成功返回绑定实例的凭据并占用一个名额；
// 没有候选时返回 ok=false，不占名额。
func (s *Shield) Admit() (Ticket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	var best *instance
	for _, inst := range s.instances {
		s.refresh(inst, now)
		var admissible bool
		switch inst.stage {
		case StageNormal:
			admissible = inst.inFlight < maxInFlight
		case StageProbing:
			admissible = !inst.probeActive && inst.inFlight < maxInFlight
		}
		if !admissible {
			continue
		}
		if best == nil || inst.inFlight < best.inFlight {
			best = inst
		}
	}
	if best == nil {
		return Ticket{}, false
	}

	req := &request{inst: best, active: true}
	if best.stage == StageProbing {
		req.probe = true
		req.deadline = now.Add(probeTimeout)
		best.probeActive = true
		best.probeDeadline = req.deadline
		best.probeReq = req
	}
	best.inFlight++

	s.nextTicket++
	s.reqs[s.nextTicket] = req
	return Ticket{InstanceID: best.id, id: s.nextTicket}, true
}

// Report 回报结果。同一凭据只接受第一次有效回报，
// 之后的重复回报不再归还名额，也不贡献样本。
func (s *Shield) Report(t Ticket, r Result) {
	s.mu.Lock()
	defer s.mu.Unlock()

	req, ok := s.reqs[t.id]
	if !ok {
		return
	}
	inst := req.inst
	now := s.now()
	s.refresh(inst, now)
	if !req.active {
		return // 已回报过，或试探已被判超时
	}
	req.active = false
	delete(s.reqs, t.id)
	inst.inFlight--

	if req.probe {
		if inst.stage == StageProbing && inst.probeReq == req {
			inst.probeActive = false
			inst.probeReq = nil
			if r == ResultSuccess {
				inst.stage = StageNormal
				inst.samples = nil // 恢复正常从空窗口开始
			} else {
				inst.stage = StageOpen
				inst.openUntil = now.Add(openDuration)
			}
		}
		return
	}

	// 普通请求：只有仍处于正常阶段时才贡献样本。
	if inst.stage != StageNormal {
		return
	}
	inst.samples = append(inst.samples, sample{t: now, fail: r == ResultFailure})
	cutoff := now.Add(-windowDuration)
	keep := 0
	for keep < len(inst.samples) && !inst.samples[keep].t.After(cutoff) {
		keep++
	}
	inst.samples = inst.samples[keep:]

	total := len(inst.samples)
	if total < minSamples {
		return
	}
	fails := 0
	for _, sm := range inst.samples {
		if sm.fail {
			fails++
		}
	}
	if fails*2 > total {
		inst.stage = StageOpen
		inst.openUntil = now.Add(openDuration)
		inst.samples = nil
	}
}

// Status 查看实例在当前业务时间下的阶段与在途数。
func (s *Shield) Status(instanceID string) (Status, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	inst, ok := s.byID[instanceID]
	if !ok {
		return Status{}, false
	}
	s.refresh(inst, s.now())
	return Status{InstanceID: inst.id, Stage: inst.stage, InFlight: inst.inFlight}, true
}
