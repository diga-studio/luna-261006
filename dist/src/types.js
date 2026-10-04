"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostState = void 0;
/** 主机生命周期状态。 */
var HostState;
(function (HostState) {
    HostState["Online"] = "online";
    HostState["Draining"] = "draining";
    HostState["Maintenance"] = "maintenance";
})(HostState || (exports.HostState = HostState = {}));
