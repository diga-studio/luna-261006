export function cidrContains(cidr, address) {
    if (cidr.prefixLength === 0) {
        return true;
    }
    const mask = (~0 << (32 - cidr.prefixLength)) >>> 0;
    return (cidr.address & mask) === (address & mask);
}
function portInRange(range, port) {
    return port >= range.start && port <= range.end;
}
function timeMatches(timeRanges, minuteOfWeek) {
    if (timeRanges.length === 0) {
        return true;
    }
    return timeRanges.some((range) => minuteOfWeek >= range.startMinute && minuteOfWeek < range.endMinute);
}
export function ruleMatches(rule, packet) {
    if (rule.protocol !== packet.protocol) {
        return false;
    }
    if (!cidrContains(rule.sourceCidr, packet.sourceAddress)) {
        return false;
    }
    if (!cidrContains(rule.destinationCidr, packet.destinationAddress)) {
        return false;
    }
    if (rule.protocol === "TCP" || rule.protocol === "UDP") {
        if (rule.sourcePorts === undefined ||
            rule.destinationPorts === undefined ||
            packet.sourcePort === undefined ||
            packet.destinationPort === undefined) {
            return false;
        }
        if (!portInRange(rule.sourcePorts, packet.sourcePort)) {
            return false;
        }
        if (!portInRange(rule.destinationPorts, packet.destinationPort)) {
            return false;
        }
    }
    return timeMatches(rule.timeRanges, packet.minuteOfWeek);
}
