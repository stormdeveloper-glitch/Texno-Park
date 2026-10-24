import io

with open('_sell_endpoint.py', 'r', encoding='utf-8') as f:
    new_code = f.read()

with open('app.py', 'r', encoding='utf-8') as f:
    content = f.read()

marker = 'def audit_sync_changes'
idx = content.find(marker)

if idx == -1:
    print('ERROR: marker not found')
else:
    new_content = content[:idx] + '\n\n' + new_code + '\n' + content[idx:]
    with open('app.py', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print('Inserted successfully. New file size:', len(new_content))
