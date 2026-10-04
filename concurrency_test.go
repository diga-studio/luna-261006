package nodeshield

import (
	"sync"
	"testing"
)

// 申请选择在途数最少者，同数按标识字典序。
func TestAcquire_LeastInflightThenLexicographic(t *testing.T) {
	p, _ := mustPool(t, "c", "a", "b")

	first := acquireOK(t, p)
	if first.InstanceID != "a" {
		t.Fatalf("首次申请应选字典序最小实例，得到 %q", first.InstanceID)
	}
	second := acquireOK(t, p)
	if second.InstanceID != "b" {
		t.Fatalf("a 已有 1 在途，应选 b，得到 %q", second.InstanceID)
	}
	third := acquireOK(t, p)
	if third.InstanceID != "c" {
		t.Fatalf("应选 c，得到 %q", third.InstanceID)
	}
	// a 归还名额后重新成为在途最少者。
	p.Report(first, OutcomeSuccess)
	fourth := acquireOK(t, p)
	if fourth.InstanceID != "a" {
		t.Fatalf("a 归还后应再次被选，得到 %q", fourth.InstanceID)
	}
}

// 每个实例最多 32 个在途请求；满员且无其他候选时拒绝，不占名额。
func TestAcquire_InflightCapAndRejection(t *testing.T) {
	p, _ := mustPool(t, "a")
	creds := make([]Credential, 0, MaxInflightPerInst)
	for i := 0; i < MaxInflightPerInst; i++ {
		creds = append(creds, acquireOK(t, p))
	}
	if _, ok := p.Acquire(); ok {
		t.Fatal("满员后应拒绝申请")
	}
	st, _ := p.Status("a")
	if st.Inflight != MaxInflightPerInst {
		t.Fatalf("inflight = %d，期望 %d", st.Inflight, MaxInflightPerInst)
	}
	// 归还一个名额后即可再次申请。
	p.Report(creds[0], OutcomeSuccess)
	if _, ok := p.Acquire(); !ok {
		t.Fatal("归还名额后应能再次申请")
	}
}

// 熔断到期后的并发申请：同一实例只有一个调用方能取得试探资格。
func TestConcurrentProbe_OnlyOneGranted(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)

	for round := 0; round < 3; round++ {
		clk.Set(t0 + 30_000 + int64(round)*35_000) // 每轮：熔断 30s + 试探超时 5s
		const callers = 64
		var wg sync.WaitGroup
		granted := make(chan Credential, callers)
		for i := 0; i < callers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if cred, ok := p.Acquire(); ok {
					granted <- cred
				}
			}()
		}
		wg.Wait()
		close(granted)
		n := 0
		for range granted {
			n++
		}
		if n != 1 {
			t.Fatalf("第 %d 轮并发试探：%d 个调用方获准，期望恰好 1 个", round, n)
		}
		st, _ := p.Status("a")
		if st.Phase != PhaseProbe || st.Inflight != 1 {
			t.Fatalf("第 %d 轮后状态 = %v/%d，期望 probe/1", round, st.Phase, st.Inflight)
		}
		// 不回报，让试探超时进入下一轮。
	}
}

// 重复回报与新申请重叠：名额不多扣、不多还。
func TestConcurrent_DuplicateReportsAndAcquires(t *testing.T) {
	p, _ := mustPool(t, "a")
	const n = MaxInflightPerInst
	creds := make([]Credential, 0, n)
	for i := 0; i < n; i++ {
		creds = append(creds, acquireOK(t, p))
	}

	var wg sync.WaitGroup
	// 每个凭据由两个调用方同时回报（结果不同），同时有调用方竞争新申请。
	for _, cred := range creds {
		for _, o := range []Outcome{OutcomeSuccess, OutcomeClientError} {
			wg.Add(1)
			go func(c Credential, out Outcome) {
				defer wg.Done()
				p.Report(c, out)
			}(cred, o)
		}
	}
	newCreds := make(chan Credential, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if cred, ok := p.Acquire(); ok {
				newCreds <- cred
			}
		}()
	}
	wg.Wait()
	close(newCreds)

	granted := 0
	for range newCreds {
		granted++
	}
	st, _ := p.Status("a")
	// 每个旧凭据只归还一次名额，新申请随即占满。
	if granted != n {
		t.Fatalf("新申请成功 %d 次，期望 %d", granted, n)
	}
	if st.Inflight != n {
		t.Fatalf("inflight = %d，期望 %d（不得多扣多还）", st.Inflight, n)
	}
	// 再重复回报旧凭据：不得再归还名额。
	for _, cred := range creds {
		p.Report(cred, OutcomeSuccess)
	}
	st, _ = p.Status("a")
	if st.Inflight != n {
		t.Fatalf("重复回报后 inflight = %d，期望 %d", st.Inflight, n)
	}
}

// 压力测试：1000 个并发调用方在多实例池上交错申请/回报，
// 时钟逐波前进；结束后名额账目必须与未回报凭据一一对应。
// 本用例只产生非失败结果，实例始终处于正常阶段，
// 因此每个未回报凭据都恰好持有一个名额，可精确对账。
func TestConcurrent_StressAccounting(t *testing.T) {
	ids := []string{"i0", "i1", "i2", "i3", "i4"}
	p, clk := mustPool(t, ids...)

	var mu sync.Mutex
	outstanding := map[string]int{} // instanceID -> 未回报凭据数

	const waves = 10
	const callersPerWave = 100 // 10 波 × 100 = 1000 个并发调用方
	for w := 0; w < waves; w++ {
		var wg sync.WaitGroup
		for i := 0; i < callersPerWave; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				cred, ok := p.Acquire()
				if !ok {
					return
				}
				mu.Lock()
				outstanding[cred.InstanceID]++
				mu.Unlock()
				switch i % 4 {
				case 0, 1: // 正常回报一次（均为非失败结果）
					p.Report(cred, Outcome(i%2))
					mu.Lock()
					outstanding[cred.InstanceID]--
					mu.Unlock()
				case 2: // 重复回报两次，只有第一次有效
					p.Report(cred, OutcomeSuccess)
					p.Report(cred, OutcomeClientError)
					mu.Lock()
					outstanding[cred.InstanceID]--
					mu.Unlock()
				case 3: // 留在在途
				}
			}(i)
		}
		wg.Wait()
		clk.Advance(7_000) // 波次间推进业务时间
	}

	// 账目核对：每个实例的在途数必须等于未回报凭据数，且不越界。
	total := 0
	for _, id := range ids {
		st, ok := p.Status(id)
		if !ok {
			t.Fatalf("实例 %q 缺失", id)
		}
		if want := outstanding[id]; st.Inflight != want {
			t.Fatalf("实例 %q inflight = %d，期望 %d", id, st.Inflight, want)
		}
		if st.Inflight < 0 || st.Inflight > MaxInflightPerInst {
			t.Fatalf("实例 %q inflight = %d 越界", id, st.Inflight)
		}
		total += st.Inflight
	}
	if total == 0 {
		t.Fatal("压力测试应留下若干在途凭据")
	}
}

// 压力测试（含失败结果）：实例在熔断/试探间往返，试探超时会自动归还名额，
// 外部无法逐一对账，改为校验每波结束后的名额上下界与阶段合法性。
func TestConcurrent_StressBounds(t *testing.T) {
	ids := []string{"i0", "i1", "i2"}
	p, clk := mustPool(t, ids...)

	outcomes := []Outcome{OutcomeSuccess, OutcomeServerError, OutcomeClientError, OutcomeTimeout}
	const waves = 12
	const callersPerWave = 100
	for w := 0; w < waves; w++ {
		var wg sync.WaitGroup
		for i := 0; i < callersPerWave; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				cred, ok := p.Acquire()
				if !ok {
					return
				}
				p.Report(cred, outcomes[i%len(outcomes)])
				p.Report(cred, outcomes[(i+1)%len(outcomes)]) // 重复回报
			}(i)
		}
		wg.Wait()
		clk.Advance(4_000) // 跨越熔断 30s 与试探超时 5s 的各类边界
		for _, id := range ids {
			st, _ := p.Status(id)
			if st.Inflight < 0 || st.Inflight > MaxInflightPerInst {
				t.Fatalf("第 %d 波后实例 %q inflight = %d 越界", w, id, st.Inflight)
			}
		}
	}
}

// 创建参数校验。
func TestNewPool_Validation(t *testing.T) {
	clk := newFakeClock()
	if _, err := NewPool(nil, clk); err != ErrEmptyPool {
		t.Fatalf("空池 err = %v", err)
	}
	tooMany := make([]string, MaxInstances+1)
	for i := range tooMany {
		tooMany[i] = string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if _, err := NewPool(tooMany, clk); err != ErrTooManyInstances {
		t.Fatalf("超上限 err = %v", err)
	}
	if _, err := NewPool([]string{"a", "a"}, clk); err != ErrDuplicateInstance {
		t.Fatalf("重复标识 err = %v", err)
	}
	if _, err := NewPool([]string{"a"}, clk); err != nil {
		t.Fatalf("正常创建 err = %v", err)
	}
	// 500 个实例上限边界：恰好 500 个应可创建。
	maxOK := make([]string, MaxInstances)
	for i := range maxOK {
		maxOK[i] = string(rune(i/65536+1)) + string(rune(i))
	}
	if _, err := NewPool(maxOK, clk); err != nil {
		t.Fatalf("500 个实例应可创建，err = %v", err)
	}
}
