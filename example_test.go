package terrasync_test

import (
	"fmt"
	"os"

	"terrasync"
)

// Example shows the append-only file workflow: feed chunks, checkpoint at
// any byte boundary, and resume later from the snapshot alone.
func Example() {
	data := []byte("\xEF\xBB\xBFname,note\n\"a,b\",\"x\"\"y\"\nlast,row")

	p := terrasync.New(terrasync.UTF8)
	recs, err := p.Feed(data[:20])
	if err != nil {
		panic(err)
	}
	for _, r := range recs {
		fmt.Printf("fields=%q span=[%d,%d)\n", r.Fields, r.Start, r.End)
	}

	// Persist progress; the process may exit here.
	state, next, err := p.Checkpoint()
	if err != nil {
		panic(err)
	}
	_ = os.WriteFile("/tmp/terrasync.ckpt", state, 0o644)

	// Later, possibly in another process: resume from the snapshot.
	raw, _ := os.ReadFile("/tmp/terrasync.ckpt")
	q, err := terrasync.Restore(raw)
	if err != nil {
		panic(err)
	}
	recs, err = q.Feed(data[next:])
	if err != nil {
		panic(err)
	}
	tail, err := q.Finish()
	if err != nil {
		panic(err)
	}
	for _, r := range append(recs, tail...) {
		fmt.Printf("fields=%q span=[%d,%d)\n", r.Fields, r.Start, r.End)
	}
	// Output:
	// fields=["name" "note"] span=[3,13)
	// fields=["a,b" "x\"y"] span=[13,26)
	// fields=["last" "row"] span=[26,34)
}
