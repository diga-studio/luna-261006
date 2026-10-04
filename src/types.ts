/** 许可池：同款软件某次采购形成的一组席位 */
export interface LicensePool {
  /** 许可池唯一标识 */
  poolId: string;
  /** 席位总数（本池最多绑定的设备数） */
  totalSeats: number;
  /** 到期日（YYYY-MM-DD），到期日当天仍有效 */
  expiresOn: string;
  /** 允许覆盖的部门集合 */
  allowedDepartments: ReadonlyArray<string>;
}

/** 待授权设备 */
export interface Device {
  /** 设备唯一标识 */
  deviceId: string;
  /** 设备当前所属部门 */
  department: string;
  /** 上一轮核算结果中的原许可池绑定；无绑定则为 undefined/null */
  previousPoolId?: string | null;
}

/** 单台设备的最终绑定结果 */
export interface DeviceAssignment {
  deviceId: string;
  poolId: string;
}

/** 重排结果 */
export interface ReallocationResult {
  /** 获得有效授权的设备绑定 */
  assignments: DeviceAssignment[];
  /** 未能覆盖的设备标识 */
  uncoveredDeviceIds: string[];
  /** 获得授权的设备总数 */
  coveredCount: number;
  /** 保持原许可池绑定的设备数（原先无绑定的不计入） */
  preservedCount: number;
}
