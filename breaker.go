package nodeshield

import (
	"errors"
	"fmt"
	"sync"
)

// 业务常量。
const (
	MaxInstances       = 500
	MaxInflightPerInst = 32

	windowMs       = 60_000 // 正常阶段统计窗口（毫秒）
	minSamples     = 20     // 触发熔断所需的最少样本数
	openDurationMs = 30_000 // 熔断时长（毫秒）
	probeTimeoutMs = 5_000  // 试探请求超时（毫秒）
)

// Phase 表示实例所处阶段。
type Phase int

const (
	PhaseNormal Phase = iota // 正常
	PhaseOpen                // 熔断
	PhaseProbe               // 试探
)

// String 实现 fmt.Stringer。
func (p Phase) String() string {
	switch p {
	case PhaseNormal:
		return "normal"
	case PhaseOpen:
		return "open"
	case PhaseProbe:
		return "probe"
	default:
		return "unknown"
	}
}

// Outcome 表示一次请求的结果。
type Outcome int

const (
	OutcomeSuccess     Outcome = iota // 成功
	OutcomeClientError                // 4xx 等非 5xx，算成功
	OutcomeServerError                // 5xx，算失败
	OutcomeTimeout                    // 超时，算失败
)

// Failed 报告该结果是否计为失败：5xx 与超时算失败，其余算成功。
func (o Outcome) Failed() bool {
	return o == OutcomeServerError || o == OutcomeTimeout
}

// Credential 是申请成功后返回的请求凭据，绑定具体实例。
type Credential struct {
	Token      string // 全局唯一凭据标识
	InstanceID string // 绑定的实例标识
}

// Status 是实例在某一业务时刻的视图。
type Status struct {
	Phase    Phase
	Inflight int
}

// ErrTooManyInstances 表示实例数超过上限。
var ErrTooManyInstances = errors.New("nodeshield: 实例数超过 500")

// ErrDuplicateInstance 表示实例标识重复。
var ErrDuplicateInstance = errors.New("nodeshield: 实例标识重复")

// ErrEmptyPool 表示实例池为空。
var ErrEmptyPool = errors.New("nodeshield: 实例池为空")

// sample 是正常阶段窗口内的一条完成记录。
type sample struct {
	at     int64 // 完成时刻（毫秒）
	failed bool
}

// probeState 描述一个尚未结束的试探请求。
type probeState struct {
	token    string
	deadline int64 // 截止时刻，恰在该时刻回报也按超时处理
}

// instance 是单个实例的运行时状态。
type instance struct {
	id       string
	phase    Phase
	inflight int
	samples  []sample // 仅正常阶段有意义，按完成时刻升序
	epoch    uint64   // 每次恢复正常时递增，用于隔离旧凭据

	openUntil int64       // 熔断阶段：允许进入试探的时刻
	probe     *probeState // 试探阶段：当前未结束的试探，无则为 nil
}

// liveCred 记录一个尚未归还名额的凭据。
type liveCred struct {
	inst    *instance
	epoch   uint64 // 申请时实例的 epoch
	isProbe bool
}

// Pool 是实例熔断与请求准入库，状态保存在进程内存中，可并发使用。
type Pool struct {
	mu    sync.Mutex
	clock Clock

	insts []*instance // 固定实例池，运行期间不增删
	byID  map[string]*instance
	live  map[string]*liveCred // 按凭据标识索引的未结束请求
	seq   uint64               // 凭据序号
}

// NewPool 以固定实例池创建 Pool；实例标识必须唯一，运行期间不增删。
func NewPool(ids []string, clock Clock) (*Pool, error) {
	if len(ids) == 0 {
		return nil, ErrEmptyPool
	}
	if len(ids) > MaxInstances {
		return nil, ErrTooManyInstances
	}
	p := &Pool{
		clock: clock,
		byID:  make(map[string]*instance, len(ids)),
		live:  make(map[string]*liveCred),
	}
	for _, id := range ids {
		if _, dup := p.byID[id]; dup {
			return nil, ErrDuplicateInstance
		}
		inst := &instance{id: id, phase: PhaseNormal}
		p.insts = append(p.insts, inst)
		p.byID[id] = inst
	}
	return p, nil
}

// advance 将实例状态推进到业务时刻 now：处理熔断到期与试探超时。
// 所有时间效果都按其实际发生时刻计算，与调用时刻无关。
func (p *Pool) advance(inst *instance, now int64) {
	for {
		switch inst.phase {
		case PhaseOpen:
			if now < inst.openUntil {
				return
			}
			inst.phase = PhaseProbe
		case PhaseProbe:
			if inst.probe == nil || now < inst.probe.deadline {
				return
			}
			// 试探超时：归还名额，从截止时刻起重新熔断 30 秒。
			deadline := inst.probe.deadline
			delete(p.live, inst.probe.token)
			inst.inflight--
			inst.probe = nil
			inst.phase = PhaseOpen
			inst.openUntil = deadline + openDurationMs
		default:
			return
		}
	}
}

// Acquire 申请一次转发。成功返回绑定实例的凭据并立即占用一个名额；
// 没有候选实例时返回 ok=false，不占名额。
func (p *Pool) Acquire() (cred Credential, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.clock.Now()
	var best *instance
	for _, inst := range p.insts {
		p.advance(inst, now)
		if !inst.accepting() {
			continue
		}
		if best == nil || inst.inflight < best.inflight ||
			(inst.inflight == best.inflight && inst.id < best.id) {
			best = inst
		}
	}
	if best == nil {
		return Credential{}, false
	}

	p.seq++
	token := fmt.Sprintf("c%d", p.seq)
	best.inflight++
	isProbe := best.phase == PhaseProbe
	if isProbe {
		best.probe = &probeState{token: token, deadline: now + probeTimeoutMs}
	}
	p.live[token] = &liveCred{inst: best, epoch: best.epoch, isProbe: isProbe}
	return Credential{Token: token, InstanceID: best.id}, true
}

// accepting 报告实例当前是否可接流量且未满。
func (inst *instance) accepting() bool {
	if inst.inflight >= MaxInflightPerInst {
		return false
	}
	switch inst.phase {
	case PhaseNormal:
		return true
	case PhaseProbe:
		return inst.probe == nil
	default:
		return false
	}
}

// Report 回报请求结果。同一凭据只接受第一次有效回报，
// 之后的重复回报不归还名额、不贡献样本。
func (p *Pool) Report(cred Credential, outcome Outcome) {
	p.mu.Lock()
	defer p.mu.Unlock()

	lc, ok := p.live[cred.Token]
	if !ok {
		return
	}
	inst := lc.inst
	now := p.clock.Now()
	// 先推进状态：恰在截止时刻回报的试探按超时处理。
	p.advance(inst, now)
	if _, still := p.live[cred.Token]; !still {
		return
	}

	// 第一次有效回报：归还名额，凭据即刻失效。
	delete(p.live, cred.Token)
	inst.inflight--

	if lc.isProbe {
		p.applyProbeResult(inst, cred.Token, outcome, now)
		return
	}
	p.applyNormalResult(inst, lc, outcome, now)
}

// applyProbeResult 处理试探请求的回报；迟到或已失效的试探不产生影响。
func (p *Pool) applyProbeResult(inst *instance, token string, outcome Outcome, now int64) {
	if inst.phase != PhaseProbe || inst.probe == nil || inst.probe.token != token {
		return
	}
	inst.probe = nil
	if outcome.Failed() {
		// 从失败时刻重新熔断 30 秒。
		inst.phase = PhaseOpen
		inst.openUntil = now + openDurationMs
		return
	}
	inst.recover()
}

// applyNormalResult 处理普通请求的回报；只有当前正常阶段、
// 当前 epoch 的凭据才贡献样本。
func (p *Pool) applyNormalResult(inst *instance, lc *liveCred, outcome Outcome, now int64) {
	if inst.phase != PhaseNormal || lc.epoch != inst.epoch {
		return
	}
	inst.samples = append(inst.samples, sample{at: now, failed: outcome.Failed()})
	// 恰距今 60 秒的样本不计入窗口。
	cut := now - windowMs
	keep := 0
	for keep < len(inst.samples) && inst.samples[keep].at <= cut {
		keep++
	}
	inst.samples = inst.samples[keep:]

	n := len(inst.samples)
	if n < minSamples {
		return
	}
	failures := 0
	for _, s := range inst.samples {
		if s.failed {
			failures++
		}
	}
	// 失败比例严格大于 50% 才触发熔断；恰好 50% 不触发。
	if failures*2 > n {
		inst.phase = PhaseOpen
		inst.openUntil = now + openDurationMs
		inst.samples = nil
	}
}

// recover 恢复正常阶段：从空窗口开始，旧凭据随之失效。
func (inst *instance) recover() {
	inst.phase = PhaseNormal
	inst.epoch++
	inst.samples = nil
	inst.probe = nil
}

// Status 查看实例在当前业务时间下的阶段与在途数。
func (p *Pool) Status(id string) (Status, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	inst, ok := p.byID[id]
	if !ok {
		return Status{}, false
	}
	p.advance(inst, p.clock.Now())
	return Status{Phase: inst.phase, Inflight: inst.inflight}, true
}
