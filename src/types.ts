export interface Device {
  id: string;
  department: string;
  previousPoolId?: string | null;
}

export interface LicensePool {
  id: string;
  totalSeats: number;
  /** ISO date (YYYY-MM-DD). Valid on the expiry day itself. */
  expiresAt: string;
  allowedDepartments: string[];
}

export interface RebalanceInput {
  /** ISO date (YYYY-MM-DD) used as the accounting date. */
  businessDate: string;
  devices: Device[];
  pools: LicensePool[];
}

export interface Assignment {
  deviceId: string;
  poolId: string;
}

export interface RebalanceResult {
  assignments: Assignment[];
  uncoveredDeviceIds: string[];
}
