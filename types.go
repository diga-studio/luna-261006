package nodeshield

import "time"

// Stage 表示实例当前所处阶段。
type Stage int

const (
	// StageNormal 正常接流量。
	StageNormal Stage = iota
	// StageOpen 熔断中，禁止新请求。
	StageOpen
	// StageProbing 试探中，最多放行一个试探请求。
	StageProbing
)

// String 返回阶段名称。
func (s Stage) String() string {
	switch s {
	case StageNormal:
		return "normal"
	case StageOpen:
		return "open"
	case StageProbing:
		return "probing"
	default:
		return "unknown"
	}
}

// Result 是一次请求的最终结果分类。
type Result int

const (
	// ResultSuccess 成功（非 5xx 且未超时）。
	ResultSuccess Result = iota
	// ResultFailure 失败（5xx 或超时）。
	ResultFailure
)

// Ticket 是申请成功后绑定实例的请求凭据。
type Ticket struct {
	InstanceID string

	id uint64 // 内部唯一序号，调用方无需关心
}

// Status 是某实例在某一业务时刻的可见状态。
type Status struct {
	InstanceID string
	Stage      Stage
	InFlight   int
}

// 内部常量。
const (
	maxInstances   = 500
	maxInFlight    = 32
	windowDuration = 60 * time.Second
	minSamples     = 20
	openDuration   = 30 * time.Second
	probeTimeout   = 5 * time.Second
)
