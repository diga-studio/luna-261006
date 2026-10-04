import type { CampSession, DoseQuery, DoseView, MedicationOrder } from "./types.js";
/** WildPine 给药剂次核算库入口，由上层直接调用。 */
export declare class MedScheduleStore {
    private readonly db;
    constructor(dbPath: string);
    /** 登记营期（幂等）。 */
    registerSession(session: CampSession): void;
    /** 装载已审核药单并展开全部剂次；装载后药单历史不再修改。 */
    loadOrder(order: MedicationOrder): void;
    /** 针对确定剂次登记实际给药 UTC 时刻；重复登记抛错且不覆盖原记录。 */
    recordAdministration(doseId: string, administeredUtcMs: number): void;
    /** 按计划 UTC 左闭右开区间查询剂次及观察时刻下的状态。 */
    queryDoses(query: DoseQuery): DoseView[];
    close(): void;
}
