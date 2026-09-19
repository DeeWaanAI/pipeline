with open('db/schema.ts', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Fix lines 224-225 (0-indexed: 223-224)
lines[223] = '});\n'
del lines[224]

with open('db/schema.ts', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print("Fixed schema.ts")
