package nodeshield

import (
	"sync"
	"testing"
	"time"
)

// TestConcurrentProbeAdmit 熔断到期后并发申请：只有一个调用方能取得试探资格。
func TestConcurrentProbeAdmit(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	const callers = 200
	var wg sync.WaitGroup
	wins := make(chan Ticket, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tk, ok := s.Admit(); ok {
				wins <- tk
			}
		}()
	}
	wg.Wait()
	close(wins)

	var granted []Ticket
	for tk := range wins {
		granted = append(granted, tk)
	}
	if len(granted) != 1 {
		t.Fatalf("exactly one probe may be granted, got %d", len(granted))
	}
	if st, _ := s.Status("x"); st.InFlight != 1 {
		t.Fatalf("probe occupies exactly one slot, got %d", st.InFlight)
	}
	s.Report(granted[0], ResultSuccess)
	if st, _ := s.Status("x"); st.Stage != StageNormal || st.InFlight != 0 {
		t.Fatalf("probe success must recover cleanly, got %+v", st)
	}
}

// TestConcurrentAdmitCap 多实例下并发申请不得超发名额。
func TestConcurrentAdmitCap(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"a", "b", "c"}, c)

	const callers = 1000
	var wg sync.WaitGroup
	wins := make(chan Ticket, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tk, ok := s.Admit(); ok {
				wins <- tk
			}
		}()
	}
	wg.Wait()
	close(wins)

	seen := map[uint64]bool{}
	perInst := map[string]int{}
	total := 0
	for tk := range wins {
		total++
		perInst[tk.InstanceID]++
		if seen[tk.id] {
			t.Fatal("duplicate ticket id issued")
		}
		seen[tk.id] = true
	}
	if total != 3*maxInFlight {
		t.Fatalf("want %d granted, got %d", 3*maxInFlight, total)
	}
	for id, n := range perInst {
		if n > maxInFlight {
			t.Fatalf("instance %s over-issued: %d", id, n)
		}
		st, _ := s.Status(id)
		if st.InFlight != n {
			t.Fatalf("instance %s: status %d != counted %d", id, st.InFlight, n)
		}
	}
}

// TestConcurrentReportAndAdmit 重复回报与新申请重叠：名额不多扣、不多还。
func TestConcurrentReportAndAdmit(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)

	tickets := make([]Ticket, maxInFlight)
	for i := range tickets {
		tickets[i] = mustAdmit(t, s)
	}

	const callers = 500
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// 对同一批凭据重复回报，并交错新申请。
			s.Report(tickets[i%maxInFlight], ResultSuccess)
			if tk, ok := s.Admit(); ok {
				s.Report(tk, ResultFailure)
			}
			s.Report(tickets[(i+1)%maxInFlight], ResultFailure)
		}(i)
	}
	wg.Wait()

	st, _ := s.Status("x")
	if st.InFlight < 0 {
		t.Fatalf("in-flight went negative: %d", st.InFlight)
	}
	if st.InFlight > maxInFlight {
		t.Fatalf("in-flight exceeded cap: %d", st.InFlight)
	}
	// 每个原始凭据只被归还一次：最终全部释放后必须归零。
	for _, tk := range tickets {
		s.Report(tk, ResultSuccess)
	}
	st, _ = s.Status("x")
	if st.InFlight != 0 {
		t.Fatalf("all slots must be released exactly once, got %d", st.InFlight)
	}
}

// TestConcurrentProbeTimeoutRace 试探截止时刻附近并发回报与查看，
// 验证状态等价于某种串行执行且名额守恒。
func TestConcurrentProbeTimeoutRace(t *testing.T) {
	c := newFakeClock()
	s := mustNew(t, []string{"x"}, c)
	trip(t, s)
	c.Advance(30 * time.Second)

	probe := mustAdmit(t, s)
	c.Advance(5 * time.Second) // 恰好到截止时刻

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				s.Report(probe, ResultSuccess)
			} else {
				s.Status("x")
			}
		}(i)
	}
	wg.Wait()

	st, _ := s.Status("x")
	if st.Stage != StageOpen {
		t.Fatalf("probe at deadline counts as timeout, got %s", st.Stage)
	}
	if st.InFlight != 0 {
		t.Fatalf("timed-out probe slot released exactly once, got %d", st.InFlight)
	}
	// 截止时刻起 30s 后可再次试探，且仍只有一个。
	c.Advance(30 * time.Second)
	wins := make(chan Ticket, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tk, ok := s.Admit(); ok {
				wins <- tk
			}
		}()
	}
	wg.Wait()
	close(wins)
	n := 0
	for range wins {
		n++
	}
	if n != 1 {
		t.Fatalf("exactly one probe after timeout reopen, got %d", n)
	}
}
