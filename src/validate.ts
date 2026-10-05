import type { DeviceInput, PlanRequest } from "./types";

export const MAX_DEVICES = 18;
export const MAX_CANDIDATES = 10;
export const MAX_RESOURCES = 8;
export const MAX_WINDOW_HOURS = 48;
export const MIN_DURATION = 1;
export const MAX_DURATION = 8;
export const MIN_CANDIDATE_GAP = 8;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function assertInteger(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${what} 必须是整数，实际为 ${String(value)}`);
  }
}

/** 校验单台设备输入。 */
function validateDevice(device: DeviceInput, index: number): void {
  const where = `设备[${index}](id=${String(device?.id)})`;
  if (typeof device.id !== "string" || device.id.length === 0) {
    throw new ValidationError(`${where} 的 id 必须是非空字符串`);
  }
  assertInteger(device.windowStart, `${where} 的 windowStart`);
  assertInteger(device.windowEnd, `${where} 的 windowEnd`);
  if (device.windowEnd < device.windowStart) {
    throw new ValidationError(`${where} 的可检修区间上界小于下界`);
  }
  if (device.windowEnd - device.windowStart > MAX_WINDOW_HOURS) {
    throw new ValidationError(
      `${where} 的可检修区间超过 ${MAX_WINDOW_HOURS} 小时`,
    );
  }
  assertInteger(device.duration, `${where} 的 duration`);
  if (device.duration < MIN_DURATION || device.duration > MAX_DURATION) {
    throw new ValidationError(
      `${where} 的检修时长必须在 ${MIN_DURATION} 至 ${MAX_DURATION} 小时之间`,
    );
  }
  if (!Array.isArray(device.resourceIds) || device.resourceIds.length === 0) {
    throw new ValidationError(`${where} 的 resourceIds 必须是非空数组`);
  }
  const seen = new Set<string>();
  for (const rid of device.resourceIds) {
    if (typeof rid !== "string" || rid.length === 0) {
      throw new ValidationError(`${where} 的资源编号必须是非空字符串`);
    }
    if (seen.has(rid)) {
      throw new ValidationError(`${where} 的资源编号 ${rid} 重复`);
    }
    seen.add(rid);
  }
}

/**
 * 校验规划请求，返回排序后的设备与候选时点副本，
 * 保证计算结果与输入顺序无关。
 */
export function validateRequest(request: PlanRequest): {
  devices: DeviceInput[];
  candidateStarts: number[];
} {
  if (request == null || typeof request !== "object") {
    throw new ValidationError("请求不能为空");
  }
  const { devices, candidateStarts } = request;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new ValidationError("设备列表不能为空");
  }
  if (devices.length > MAX_DEVICES) {
    throw new ValidationError(`设备数量不能超过 ${MAX_DEVICES} 台`);
  }
  devices.forEach(validateDevice);
  const ids = new Set<string>();
  for (const device of devices) {
    if (ids.has(device.id)) {
      throw new ValidationError(`设备编号 ${device.id} 重复`);
    }
    ids.add(device.id);
  }
  const allResources = new Set<string>();
  for (const device of devices) {
    for (const rid of device.resourceIds) allResources.add(rid);
  }
  if (allResources.size > MAX_RESOURCES) {
    throw new ValidationError(`隔离资源种类不能超过 ${MAX_RESOURCES} 种`);
  }
  if (!Array.isArray(candidateStarts)) {
    throw new ValidationError("候选停机时点必须是数组");
  }
  if (candidateStarts.length > MAX_CANDIDATES) {
    throw new ValidationError(`候选时点数量不能超过 ${MAX_CANDIDATES} 个`);
  }
  candidateStarts.forEach((t, i) => assertInteger(t, `候选时点[${i}]`));
  const sortedStarts = [...candidateStarts].sort((a, b) => a - b);
  for (let i = 1; i < sortedStarts.length; i++) {
    if (sortedStarts[i] === sortedStarts[i - 1]) {
      throw new ValidationError(`候选时点 ${sortedStarts[i]} 重复`);
    }
    if ((sortedStarts[i] as number) - (sortedStarts[i - 1] as number) < MIN_CANDIDATE_GAP) {
      throw new ValidationError(
        `相邻候选时点 ${sortedStarts[i - 1]} 与 ${sortedStarts[i]} 间隔不足 ${MIN_CANDIDATE_GAP} 小时`,
      );
    }
  }
  const sortedDevices = [...devices].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { devices: sortedDevices, candidateStarts: sortedStarts };
}
