## feature/devops-anomalias
- .github/workflows/ci.yml: runs-on ubuntu-latest + actions/setup-node@v4 Node 20 + cache npm + npm ci + lint + test + build + comentario coverage em PR
- .github/workflows/devops-inteligente.yml: analise ultimos 30 runs, heuristica P(falha)=0.6*historico+0.3*recencia+0.1*latencia; se risco>=30% abre Issue
- Anomalias: recorrencia erros lint >30%, tool retry >2, steps duracao >3x media movel

