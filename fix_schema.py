import re

with open('db/schema.ts', 'r') as f:
    content = f.read()

# Fix the malformed duplicate at lines 223-225
# The correct closing should be:
#   batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),
# }));
#
# But we have garbage after line 223:
# }));"idx_swarm_runs_batch_id").on(table.batchId),
# });

old = '''  batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),
}));"idx_swarm_runs_batch_id").on(table.batchId),
});

// ─── SWARM BATCHES (Research Mode: batch run groups) ───────────────'''

new = '''  batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),
}));

// ─── SWARM BATCHES (Research Mode: batch run groups) ───────────────'''

if old in content:
    content = content.replace(old, new)
    print("Fixed malformed closing")
else:
    print("Pattern not found, checking raw content around line 220")
    lines = content.split('\n')
    for i, line in enumerate(lines[218:230], start=219):
        print(f"{i}: {repr(line)}")

with open('db/schema.ts', 'w') as f:
    f.write(content)
