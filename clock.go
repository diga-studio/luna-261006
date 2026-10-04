package nodeshield

import "time"

// Clock 提供单调业务时间，精度为毫秒，只前进不回退。
type Clock interface {
	// Now 返回当前业务时间，单位为毫秒。
	Now() int64
}

// realClock 基于系统单调时钟的 Clock 实现。
type realClock struct {
	start time.Time
}

// NewRealClock 返回以进程启动为基准的系统单调时钟。
func NewRealClock() Clock {
	return &realClock{start: time.Now()}
}

func (c *realClock) Now() int64 {
	return time.Since(c.start).Milliseconds()
}
