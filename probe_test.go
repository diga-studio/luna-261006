package nodeshield

import "testing"

// trip 让单实例池立即进入熔断阶段，返回触发时刻。
func trip(t *testing.T, p *Pool, clk *fakeClock) int64 {
	t.Helper()
	reportN(t, p, repeat(OutcomeServerError, 20)...)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("熔断后阶段 = %v，期望 open", got)
	}
	return clk.Now()
}

// 熔断 30 秒期间禁止新请求；到期时刻起允许试探。
func TestOpenDurationBoundary(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)

	clk.Set(t0 + 29_999)
	if _, ok := p.Acquire(); ok {
		t.Fatal("熔断到期前不应放行请求")
	}
	clk.Set(t0 + 30_000)
	cred, ok := p.Acquire()
	if !ok {
		t.Fatal("熔断到期后应允许试探")
	}
	if got := phaseOf(t, p, "a"); got != PhaseProbe {
		t.Fatalf("阶段 = %v，期望 probe", got)
	}
	st, _ := p.Status("a")
	if st.Inflight != 1 {
		t.Fatalf("试探请求应占用名额，inflight = %d，期望 1", st.Inflight)
	}
	if cred.InstanceID != "a" {
		t.Fatalf("凭据绑定实例 = %q，期望 a", cred.InstanceID)
	}
}

// 试探阶段最多一个未结束的试探请求。
func TestProbe_OnlyOneOutstanding(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	if _, ok := p.Acquire(); !ok {
		t.Fatal("首个试探应获准")
	}
	if _, ok := p.Acquire(); ok {
		t.Fatal("已有未结束试探时不应再放行")
	}
}

// 试探成功则恢复正常；成功试探本身不进入新窗口，新窗口从空开始。
func TestProbe_SuccessRecoversWithEmptyWindow(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	cred := acquireOK(t, p)
	clk.Advance(1_000)
	p.Report(cred, OutcomeSuccess)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("试探成功后阶段 = %v，期望 normal", got)
	}
	// 新窗口从空开始：19 个失败样本不足以熔断。
	reportN(t, p, repeat(OutcomeServerError, 19)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("恢复后 19 个失败样本阶段 = %v，期望 normal", got)
	}
	reportN(t, p, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("恢复后 20 个失败样本阶段 = %v，期望 open", got)
	}
}

// 试探失败则从失败时刻重新熔断 30 秒。
func TestProbe_FailureReopensFromFailureMoment(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	cred := acquireOK(t, p)
	clk.Advance(2_000) // t0+32000 失败
	p.Report(cred, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("试探失败后阶段 = %v，期望 open", got)
	}
	// 从失败时刻起 30 秒：t0+61999 仍熔断，t0+62000 可试探。
	clk.Set(t0 + 61_999)
	if _, ok := p.Acquire(); ok {
		t.Fatal("重新熔断到期前不应放行")
	}
	clk.Set(t0 + 62_000)
	if _, ok := p.Acquire(); !ok {
		t.Fatal("重新熔断到期后应允许试探")
	}
}

// 试探 5 秒未结束视为失败，从截止时刻起重新熔断；
// 长时间没有调用也不能推迟下一次允许试探的时间。
func TestProbe_TimeoutReopensFromDeadline(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	acquireOK(t, p) // 试探获准，截止时刻 t0+35000

	// 长时间无调用：直接跳到很久以后。
	clk.Set(t0 + 1_000_000)
	// 状态查看必须反映当前业务时间：早已重新熔断并再次到期。
	if got := phaseOf(t, p, "a"); got != PhaseProbe {
		t.Fatalf("久置后阶段 = %v，期望 probe（熔断应从截止时刻起算）", got)
	}
	st, _ := p.Status("a")
	if st.Inflight != 0 {
		t.Fatalf("超时试探的名额应已归还，inflight = %d，期望 0", st.Inflight)
	}

	// 逐步验证：重开一只，精确检查从截止时刻起算 30 秒。
	p2, clk2 := mustPool(t, "a")
	t1 := trip(t, p2, clk2)
	clk2.Set(t1 + 30_000)
	acquireOK(t, p2) // 截止 t1+35000，重新熔断至 t1+65000
	clk2.Set(t1 + 64_999)
	if got := phaseOf(t, p2, "a"); got != PhaseOpen {
		t.Fatalf("t1+64999 阶段 = %v，期望 open", got)
	}
	clk2.Set(t1 + 65_000)
	if got := phaseOf(t, p2, "a"); got != PhaseProbe {
		t.Fatalf("t1+65000 阶段 = %v，期望 probe", got)
	}
}

// 恰在截止时刻回报按超时处理；同刻到达的成功回报不能推翻超时结果。
func TestProbe_ReportExactlyAtDeadlineIsTimeout(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	cred := acquireOK(t, p) // 截止 t0+35000
	clk.Set(t0 + 35_000)
	p.Report(cred, OutcomeSuccess) // 恰在截止时刻，按超时处理
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("截止时刻回报后阶段 = %v，期望 open", got)
	}
	// 从截止时刻起熔断 30 秒：t0+64999 仍熔断，t0+65000 可试探。
	clk.Set(t0 + 64_999)
	if _, ok := p.Acquire(); ok {
		t.Fatal("t0+64999 不应放行")
	}
	clk.Set(t0 + 65_000)
	if _, ok := p.Acquire(); !ok {
		t.Fatal("t0+65000 应允许试探")
	}
}

// 上一轮试探超时后，其迟到的成功回报不能解除新熔断、不能影响新一轮试探。
func TestProbe_LateReportAfterTimeoutIgnored(t *testing.T) {
	p, clk := mustPool(t, "a")
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	stale := acquireOK(t, p) // 第一轮试探，截止 t0+35000
	clk.Set(t0 + 36_000)     // 已超时，重新熔断至 t0+65000

	// 迟到回报：不能解除熔断。
	p.Report(stale, OutcomeSuccess)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("迟到回报后阶段 = %v，期望 open", got)
	}
	st, _ := p.Status("a")
	if st.Inflight != 0 {
		t.Fatalf("迟到回报不应重复归还名额，inflight = %d，期望 0", st.Inflight)
	}

	// 新一轮试探开始后，旧成功回报到达：不能让新试探“提前成功”。
	clk.Set(t0 + 65_000)
	fresh := acquireOK(t, p)
	p.Report(stale, OutcomeSuccess)
	if got := phaseOf(t, p, "a"); got != PhaseProbe {
		t.Fatalf("新一轮试探中迟到回报后阶段 = %v，期望 probe", got)
	}
	st, _ = p.Status("a")
	if st.Inflight != 1 {
		t.Fatalf("新试探名额不应受影响，inflight = %d，期望 1", st.Inflight)
	}
	// 新试探自己失败，重新熔断。
	p.Report(fresh, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("新试探失败后阶段 = %v，期望 open", got)
	}
}

// 熔断前已在途的普通请求：首次回报归还名额，但不改变后续阶段、样本或计时。
func TestPreOpenInflight_LateReportHasNoEffect(t *testing.T) {
	p, clk := mustPool(t, "a")
	// 先让一个普通请求保持在途。
	pending := acquireOK(t, p)
	t0 := trip(t, p, clk) // t0 时刻熔断
	st, _ := p.Status("a")
	if st.Inflight != 1 {
		t.Fatalf("在途请求应继续占用名额，inflight = %d，期望 1", st.Inflight)
	}

	// 熔断期间回报：归还名额，但不解除熔断、不影响计时。
	clk.Set(t0 + 10_000)
	p.Report(pending, OutcomeSuccess)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("熔断期回报后阶段 = %v，期望 open", got)
	}
	st, _ = p.Status("a")
	if st.Inflight != 0 {
		t.Fatalf("首次回报应归还名额，inflight = %d，期望 0", st.Inflight)
	}
	// 熔断仍从 t0 起算 30 秒。
	clk.Set(t0 + 29_999)
	if _, ok := p.Acquire(); ok {
		t.Fatal("熔断到期前不应放行")
	}
	clk.Set(t0 + 30_000)
	probe := acquireOK(t, p)

	// 重复回报同一凭据：不能再次影响。
	p.Report(pending, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseProbe {
		t.Fatalf("重复回报后阶段 = %v，期望 probe", got)
	}
	st, _ = p.Status("a")
	if st.Inflight != 1 {
		t.Fatalf("重复回报不应多还名额，inflight = %d，期望 1", st.Inflight)
	}

	// 旧普通请求的迟到成功不能污染恢复后的新窗口：
	// 让试探成功恢复，随后 19 个失败不应熔断（窗口从空开始）。
	p.Report(probe, OutcomeSuccess)
	reportN(t, p, repeat(OutcomeServerError, 19)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("恢复后 19 个失败阶段 = %v，期望 normal（旧样本不得污染新窗口）", got)
	}
}

// 恢复前在途的旧普通请求，在恢复后回报也不计入新窗口。
func TestStaleNormalReportAfterRecoveryIgnored(t *testing.T) {
	p, clk := mustPool(t, "a")
	pending := acquireOK(t, p)
	t0 := trip(t, p, clk)
	clk.Set(t0 + 30_000)
	probe := acquireOK(t, p)
	p.Report(probe, OutcomeSuccess) // 恢复正常，epoch 递增
	// 旧凭据在恢复后回报：归还名额但不贡献样本。
	p.Report(pending, OutcomeServerError)
	st, _ := p.Status("a")
	if st.Inflight != 0 {
		t.Fatalf("旧凭据首次回报应归还名额，inflight = %d，期望 0", st.Inflight)
	}
	// 新窗口应只有此后发生的样本：19 个失败不熔断。
	reportN(t, p, repeat(OutcomeServerError, 19)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("阶段 = %v，期望 normal（旧失败不得计入新窗口）", got)
	}
}
