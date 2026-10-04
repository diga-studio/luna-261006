package nodeshield

import (
	"testing"
	"time"
)

// trip 让实例进入熔断：制造 20 样本中 11 个失败。
func trip(t *testing.T, s *Shield) {
	t.Helper()
	for i := 0; i < 9; i++ {
		tk := mustAdmit(t, s)
		s.Report(tk, ResultSuccess)
	}
	for i := 0; i < 11; i++ {
		tk := mustAdmit(t, s)
		s.Report(tk, ResultFailure)
	}
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("expected open, got %s", st.Stage)
	}
}

func TestOpenBlocksAndExpiresAfter30s(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)

	if _, ok := s.Admit(); ok {
		t.Fatal("open stage must reject admits")
	}
	c.Advance(30*time.Second - time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("29.999s: want open, got %s", st.Stage)
	}
	if _, ok := s.Admit(); ok {
		t.Fatal("open stage must reject admits before expiry")
	}
	c.Advance(time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("30s: want probing, got %s", st.Stage)
	}
}

func TestProbeSuccessRecoversWithEmptyWindow(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	probe := mustAdmit(t, s)
	if st, _ := s.Status("x"); st.InFlight != 1 {
		t.Fatalf("probe occupies a slot, got %d", st.InFlight)
	}
	// 试探进行中不得再放行第二个。
	if _, ok := s.Admit(); ok {
		t.Fatal("only one probe allowed")
	}
	s.Report(probe, ResultSuccess)
	if st, _ := s.Status("x"); st.Stage != StageNormal || st.InFlight != 0 {
		t.Fatalf("probe success must recover, got %+v", st)
	}
	// 新窗口为空：19 个失败样本不足以再次熔断。
	for i := 0; i < 19; i++ {
		tk := mustAdmit(t, s)
		s.Report(tk, ResultFailure)
	}
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("window must restart empty after recovery, got %s", st.Stage)
	}
}

func TestProbeFailureReopensFromFailureMoment(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	probe := mustAdmit(t, s)
	c.Advance(2 * time.Second)
	s.Report(probe, ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("probe failure must reopen, got %s", st.Stage)
	}
	// 从失败时刻起 30 秒。
	c.Advance(30*time.Second - time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("want open, got %s", st.Stage)
	}
	c.Advance(time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("want probing, got %s", st.Stage)
	}
}

func TestProbeTimeoutReopensFromDeadline(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	probe := mustAdmit(t, s)
	// 4.999s 时仍正常。
	c.Advance(5*time.Second - time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageProbing || st.InFlight != 1 {
		t.Fatalf("before deadline: %+v", st)
	}
	// 恰在截止时刻回报按超时处理。
	c.Advance(time.Millisecond)
	s.Report(probe, ResultSuccess)
	st, _ := s.Status("x")
	if st.Stage != StageOpen || st.InFlight != 0 {
		t.Fatalf("report at deadline counts as timeout, got %+v", st)
	}
	// 从截止时刻起 30 秒：截止后 29.999s 仍熔断。
	c.Advance(30*time.Second - time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("want open, got %s", st.Stage)
	}
	c.Advance(time.Millisecond)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("want probing, got %s", st.Stage)
	}
}

func TestProbeTimeoutWithLongIdleDoesNotDelayNextProbe(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	probe := mustAdmit(t, s) // 截止时刻 = now+5s
	_ = probe
	// 长时间无调用：一小时后查看，熔断应早已从截止时刻+30s 到期。
	c.Advance(time.Hour)
	st, _ := s.Status("x")
	if st.Stage != StageProbing || st.InFlight != 0 {
		t.Fatalf("long idle must not delay next probe, got %+v", st)
	}
	// 迟到的旧试探回报不能影响新一轮试探。
	s.Report(probe, ResultSuccess)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("stale probe report must be ignored, got %s", st.Stage)
	}
	probe2 := mustAdmit(t, s)
	s.Report(probe2, ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("new probe failure must reopen, got %s", st.Stage)
	}
}

func TestStaleNormalReportDoesNotAffectNewWindow(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)

	// 熔断前在途的普通请求。
	pending := mustAdmit(t, s)
	trip(t, s)
	if st, _ := s.Status("x"); st.InFlight != 1 {
		t.Fatalf("pending request still occupies slot, got %d", st.InFlight)
	}
	// 熔断期间回报：归还名额但不贡献样本、不改变计时。
	c.Advance(10 * time.Second)
	s.Report(pending, ResultSuccess)
	st, _ := s.Status("x")
	if st.Stage != StageOpen || st.InFlight != 0 {
		t.Fatalf("report during open only releases slot, got %+v", st)
	}
	// 熔断到期时刻不受该回报影响（触发后 30s）。
	c.Advance(20 * time.Second)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("want probing 30s after trip, got %s", st.Stage)
	}
	// 试探成功恢复后窗口为空：19 个失败不触发。
	probe := mustAdmit(t, s)
	s.Report(probe, ResultSuccess)
	for i := 0; i < 19; i++ {
		tk := mustAdmit(t, s)
		s.Report(tk, ResultFailure)
	}
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("old report must not pollute new window, got %s", st.Stage)
	}
}

func TestStaleProbeSuccessCannotCancelNewOpen(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	// 第一轮试探超时。
	probe1 := mustAdmit(t, s)
	c.Advance(5 * time.Second)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("probe timeout must reopen, got %s", st.Stage)
	}
	// 第二轮试探开始。
	c.Advance(30 * time.Second)
	probe2 := mustAdmit(t, s)
	// 上一轮迟到的成功回报到达：不能解除当前状态。
	s.Report(probe1, ResultSuccess)
	if st, _ := s.Status("x"); st.Stage != StageProbing {
		t.Fatalf("stale probe success must not cancel new round, got %s", st.Stage)
	}
	// 同刻到达的旧成功回报不能推翻超时结果；新一轮失败正常生效。
	s.Report(probe2, ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("new probe failure must reopen, got %s", st.Stage)
	}
}
