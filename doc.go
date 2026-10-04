// Package terrasync implements an incremental, checkpointable CSV parser
// for append-only local files.
//
// The caller owns file discovery and scheduling and pushes bytes in any
// chunking via Feed; the parser returns records as soon as they are known
// to be complete. Checkpoint exports a self-contained snapshot at any byte
// boundary, and Restore rebuilds an equivalent parser from the snapshot
// alone, so parsing can resume in another process without re-reading the
// file prefix. Results (records, order, byte spans, error offsets) are
// identical to a single uninterrupted parse of the same file.
package terrasync
