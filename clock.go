package nodeshield

import "time"

// Clock 由调用方提供，返回单调前进的业务时间（毫秒精度）。
type Clock interface {
	Now() time.Time
}

// ClockFunc 允许用函数适配 Clock 接口。
type ClockFunc func() time.Time

// Now 实现 Clock。
func (f ClockFunc) Now() time.Time { return f() }
