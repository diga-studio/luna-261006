"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Protocol = void 0;
/** 协议类型（固定三种） */
var Protocol;
(function (Protocol) {
    Protocol["ModbusTcp"] = "Modbus TCP";
    Protocol["DNP3"] = "DNP3";
    Protocol["OpcUa"] = "OPC-UA";
})(Protocol = exports.Protocol || (exports.Protocol = {}));
