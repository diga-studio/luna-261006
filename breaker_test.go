package nodeshield

import (
	"sync"
	"testing"
	"time"
)

// fakeClock 是测试用的手动单调时钟。
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.UnixMilli(1_700_000_000_000)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func mustNew(t *testing.T, ids []string, c Clock) *Shield {
	t.Helper()
	s, err := New(ids, c)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func mustAdmit(t *testing.T, s *Shield) Ticket {
	t.Helper()
	tk, ok := s.Admit()
	if !ok {
		t.Fatalf("Admit: expected success")
	}
	return tk
}

func TestNewValidation(t *testing.T) {
	c := newFakeClock()
	if _, err := New(nil, c); err == nil {
		t.Fatal("expected error for empty pool")
	}
	if _, err := New([]string{"a", "a"}, c); err == nil {
		t.Fatal("expected error for duplicate ids")
	}
	if _, err := New([]string{""}, c); err == nil {
		t.Fatal("expected error for empty id")
	}
	if _, err := New([]string{"a"}, nil); err == nil {
		t.Fatal("expected error for nil clock")
	}
	ids := make([]string, 501)
	for i := range ids {
		ids[i] = string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if _, err := New(ids, c); err == nil {
		t.Fatal("expected error for >500 instances")
	}
	if _, err := New(ids[:500], c); err != nil {
		t.Fatalf("500 instances should be ok: %v", err)
	}
}

func TestAdmitPicksLeastInFlightThenLexicographic(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"b", "a", "c"}, c)

	t1 := mustAdmit(t, s)
	if t1.InstanceID != "a" {
		t.Fatalf("tie at 0 in-flight: want a, got %s", t1.InstanceID)
	}
	t2 := mustAdmit(t, s)
	if t2.InstanceID != "b" {
		t.Fatalf("want b, got %s", t2.InstanceID)
	}
	t3 := mustAdmit(t, s)
	if t3.InstanceID != "c" {
		t.Fatalf("want c, got %s", t3.InstanceID)
	}
	// 全部在途 1，再次平局选 a。
	t4 := mustAdmit(t, s)
	if t4.InstanceID != "a" {
		t.Fatalf("tie at 1 in-flight: want a, got %s", t4.InstanceID)
	}
	s.Report(t1, ResultSuccess)
	s.Report(t2, ResultSuccess)
	s.Report(t3, ResultSuccess)
	s.Report(t4, ResultSuccess)
}

func TestInFlightCapAndRelease(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)

	tickets := make([]Ticket, 0, maxInFlight)
	for i := 0; i < maxInFlight; i++ {
		tickets = append(tickets, mustAdmit(t, s))
	}
	if _, ok := s.Admit(); ok {
		t.Fatal("expected rejection at 32 in-flight")
	}
	st, _ := s.Status("x")
	if st.InFlight != maxInFlight {
		t.Fatalf("want 32 in-flight, got %d", st.InFlight)
	}
	s.Report(tickets[0], ResultSuccess)
	st, _ = s.Status("x")
	if st.InFlight != maxInFlight-1 {
		t.Fatalf("want 31 in-flight after report, got %d", st.InFlight)
	}
	// 重复回报不得再次归还名额。
	s.Report(tickets[0], ResultSuccess)
	s.Report(tickets[0], ResultFailure)
	st, _ = s.Status("x")
	if st.InFlight != maxInFlight-1 {
		t.Fatalf("duplicate report must not release slot, got %d", st.InFlight)
	}
	if _, ok := s.Admit(); !ok {
		t.Fatal("expected admit after release")
	}
}

func TestUnknownInstanceStatus(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	if _, ok := s.Status("nope"); ok {
		t.Fatal("expected ok=false for unknown instance")
	}
}

// TestWindowThreshold 覆盖 20 个样本与 50% 比例边界。
func TestWindowThreshold(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)

	report := func(r Result) {
		tk := mustAdmit(t, s)
		s.Report(tk, r)
	}
	// 19 个样本（10 失败 9 成功）：样本不足，不触发。
	for i := 0; i < 10; i++ {
		report(ResultFailure)
	}
	for i := 0; i < 9; i++ {
		report(ResultSuccess)
	}
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("19 samples must not trip, got %s", st.Stage)
	}
	// 第 20 个样本成功：10/20 = 50%，恰好不触发。
	report(ResultSuccess)
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("exactly 50%% must not trip, got %s", st.Stage)
	}
	// 再一个失败：11/21 > 50%，触发熔断。
	report(ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("20/21 failures must trip, got %s", st.Stage)
	}
}

// TestWindowEdge 覆盖 60 秒窗口端点：恰好距今 60 秒的样本不计。
func TestWindowEdge(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)

	reportAt := func(r Result) {
		tk := mustAdmit(t, s)
		s.Report(tk, r)
	}
	// t0: 10 个失败。
	for i := 0; i < 10; i++ {
		reportAt(ResultFailure)
	}
	// t0+1ms: 10 个成功（窗口内共 20 样本，50%，不触发）。
	c.Advance(time.Millisecond)
	for i := 0; i < 10; i++ {
		reportAt(ResultSuccess)
	}
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("10/20 must not trip, got %s", st.Stage)
	}
	// 前进到 t0+60s：最早 10 个失败恰好距今 60s，被排除，
	// 窗口只剩 10 个成功样本；新来一个失败后 1/11，不触发。
	c.Advance(60*time.Second - time.Millisecond)
	reportAt(ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("samples exactly 60s old must be excluded, got %s", st.Stage)
	}
	// 回到对称场景验证窗口滑动：再补 9 个失败 -> 10/20 = 50% 不触发。
	for i := 0; i < 9; i++ {
		reportAt(ResultFailure)
	}
	if st, _ := s.Status("x"); st.Stage != StageNormal {
		t.Fatalf("10/20 must not trip, got %s", st.Stage)
	}
	// 再补 1 个失败 -> 11/21 > 50% 触发。
	reportAt(ResultFailure)
	if st, _ := s.Status("x"); st.Stage != StageOpen {
		t.Fatalf("11/21 must trip, got %s", st.Stage)
	}
}
