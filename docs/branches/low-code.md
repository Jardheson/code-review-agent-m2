## feature/low-code
- Gatilho low-code: on: pull_request [opened, synchronize, reopened, ready_for_review] + workflow_dispatch
- Passos declarativos no YAML: checkout -> setup node -> build -> gh api collect diff -> run node dist/cli review --file -> createComment PR estruturado com icone/status/exit code/summary -> upload-artifact logs+data+inputs
- API: POST /api/v1/webhook/low-code recebe evento e registra na auditoria

