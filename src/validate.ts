import type { PlantInput } from './types.js';

export const MAX_DEVICES = 18;
export const MAX_SLOTS = 10;
export const MAX_RESOURCES = 8;
export const MAX_WINDOW_HOURS = 48;
export const MIN_DURATION = 1;
export const MAX_DURATION = 8;
export const MIN_SLOT_GAP = 8;

function isInt(value: number): boolean {
  return Number.isInteger(value);
}

/** 校验输入是否满足业务约束；不合法时抛出 Error。 */
export function validateInput(input: PlantInput): void {
  if (input === null || typeof input !== 'object') {
    throw new Error('input must be an object');
  }
  const { devices, candidateSlots } = input;
  if (!Array.isArray(devices)) {
    throw new Error('devices must be an array');
  }
  if (!Array.isArray(candidateSlots)) {
    throw new Error('candidateSlots must be an array');
  }
  if (devices.length > MAX_DEVICES) {
    throw new Error(`too many devices: ${devices.length} > ${MAX_DEVICES}`);
  }
  if (candidateSlots.length > MAX_SLOTS) {
    throw new Error(`too many candidate slots: ${candidateSlots.length} > ${MAX_SLOTS}`);
  }

  const deviceIds = new Set<string>();
  const resourceIds = new Set<string>();
  for (const device of devices) {
    if (typeof device.id !== 'string' || device.id.length === 0) {
      throw new Error('device id must be a non-empty string');
    }
    if (deviceIds.has(device.id)) {
      throw new Error(`duplicate device id: ${device.id}`);
    }
    deviceIds.add(device.id);
    if (!isInt(device.windowStart) || !isInt(device.windowEnd)) {
      throw new Error(`device ${device.id}: window bounds must be integers`);
    }
    if (device.windowEnd < device.windowStart) {
      throw new Error(`device ${device.id}: windowEnd < windowStart`);
    }
    if (device.windowEnd - device.windowStart > MAX_WINDOW_HOURS) {
      throw new Error(`device ${device.id}: window longer than ${MAX_WINDOW_HOURS} hours`);
    }
    if (!isInt(device.duration) || device.duration < MIN_DURATION || device.duration > MAX_DURATION) {
      throw new Error(`device ${device.id}: duration must be an integer in [${MIN_DURATION}, ${MAX_DURATION}]`);
    }
    if (!Array.isArray(device.resourceIds) || device.resourceIds.length === 0) {
      throw new Error(`device ${device.id}: resourceIds must be a non-empty array`);
    }
    for (const resourceId of device.resourceIds) {
      if (typeof resourceId !== 'string' || resourceId.length === 0) {
        throw new Error(`device ${device.id}: resource id must be a non-empty string`);
      }
      resourceIds.add(resourceId);
    }
  }
  if (resourceIds.size > MAX_RESOURCES) {
    throw new Error(`too many resources: ${resourceIds.size} > ${MAX_RESOURCES}`);
  }

  const sortedSlots = [...candidateSlots].sort((a, b) => a - b);
  for (const slot of candidateSlots) {
    if (!isInt(slot)) {
      throw new Error('candidate slots must be integers');
    }
  }
  for (let index = 1; index < sortedSlots.length; index += 1) {
    const prev = sortedSlots[index - 1]!;
    const curr = sortedSlots[index]!;
    if (curr === prev) {
      throw new Error(`duplicate candidate slot: ${curr}`);
    }
    if (curr - prev < MIN_SLOT_GAP) {
      throw new Error(`candidate slots ${prev} and ${curr} are closer than ${MIN_SLOT_GAP} hours`);
    }
  }
}
