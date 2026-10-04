package nodeshield

import (
	"sync"
	"testing"
)

// fakeClock 是测试用的单调时钟，精度毫秒，只前进不回退。
type fakeClock struct {
	mu  sync.Mutex
	now int64
}

func newFakeClock() *fakeClock { return &fakeClock{} }

func (c *fakeClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Set(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ms > c.now {
		c.now = ms
	}
}

func (c *fakeClock) Advance(ms int64) { c.Set(c.Now() + ms) }

func mustPool(t *testing.T, ids ...string) (*Pool, *fakeClock) {
	t.Helper()
	clk := newFakeClock()
	p, err := NewPool(ids, clk)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	return p, clk
}

func acquireOK(t *testing.T, p *Pool) Credential {
	t.Helper()
	cred, ok := p.Acquire()
	if !ok {
		t.Fatal("Acquire 被意外拒绝")
	}
	return cred
}

// reportN 顺序执行 n 次 申请+回报，结果由 outcomes 给出。
func reportN(t *testing.T, p *Pool, outcomes ...Outcome) {
	t.Helper()
	for _, o := range outcomes {
		cred := acquireOK(t, p)
		p.Report(cred, o)
	}
}

func phaseOf(t *testing.T, p *Pool, id string) Phase {
	t.Helper()
	st, ok := p.Status(id)
	if !ok {
		t.Fatalf("实例 %q 不存在", id)
	}
	return st.Phase
}

func repeat(o Outcome, n int) []Outcome {
	out := make([]Outcome, n)
	for i := range out {
		out[i] = o
	}
	return out
}

// 样本不足 20 个时，即使失败比例超过 50% 也不熔断。
func TestWindow_MinSamplesRequired(t *testing.T) {
	p, _ := mustPool(t, "a")
	reportN(t, p, repeat(OutcomeServerError, 19)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("19 个样本后阶段 = %v，期望 normal", got)
	}
	// 第 20 个样本使失败数达到 20/20，立即熔断。
	reportN(t, p, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("20 个失败样本后阶段 = %v，期望 open", got)
	}
}

// 失败比例恰好 50% 不触发；严格大于 50% 才触发。
func TestWindow_ExactlyHalfDoesNotTrip(t *testing.T) {
	p, _ := mustPool(t, "a")
	reportN(t, p, repeat(OutcomeServerError, 10)...)
	reportN(t, p, repeat(OutcomeSuccess, 10)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("10/20 失败后阶段 = %v，期望 normal", got)
	}
	// 再补 1 个失败：21 个样本中 11 个失败，严格大于 50%。
	reportN(t, p, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("11/21 失败后阶段 = %v，期望 open", got)
	}
}

// 4xx 等非 5xx 结果算成功，超时算失败。
func TestOutcomeClassification(t *testing.T) {
	p, _ := mustPool(t, "a")
	reportN(t, p, repeat(OutcomeClientError, 20)...)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("20 个 4xx 后阶段 = %v，期望 normal", got)
	}
	reportN(t, p, repeat(OutcomeTimeout, 21)...)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("21/41 超时后阶段 = %v，期望 open", got)
	}
}

// 恰好距今 60 秒的样本不计入窗口。
func TestWindow_SampleExactly60sOldExcluded(t *testing.T) {
	p, clk := mustPool(t, "a")
	// t=0：10 个失败。
	reportN(t, p, repeat(OutcomeServerError, 10)...)
	// t=59000：10 个成功，总计 10/20，不熔断。
	clk.Set(59_000)
	reportN(t, p, repeat(OutcomeSuccess, 10)...)
	// t=60000：再 1 个失败。t=0 的样本恰距今 60 秒，不计入；
	// 窗口内只有 11 个样本，不足 20，不熔断。
	clk.Set(60_000)
	reportN(t, p, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseNormal {
		t.Fatalf("t=60000 阶段 = %v，期望 normal（旧样本应被排除）", got)
	}
}

// 窗口端点内侧：59.999 秒前的样本仍计入，可触发熔断。
func TestWindow_SampleJustInsideWindowCounts(t *testing.T) {
	p, clk := mustPool(t, "a")
	reportN(t, p, repeat(OutcomeServerError, 10)...)
	clk.Set(59_000)
	reportN(t, p, repeat(OutcomeSuccess, 10)...)
	// t=59999：t=0 的样本距今不足 60 秒，仍计入；
	// 窗口内 21 个样本、11 个失败，严格大于 50%，熔断。
	clk.Set(59_999)
	reportN(t, p, OutcomeServerError)
	if got := phaseOf(t, p, "a"); got != PhaseOpen {
		t.Fatalf("t=59999 阶段 = %v，期望 open", got)
	}
}
