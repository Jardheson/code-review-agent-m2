## feature/tool-integracao
- Valida entrada via StaticAnalysisInputSchema (Zod)
- Retry 2x + linear backoff em falhas temporarias
- 10 regras de analise (HARDCODED_SECRET, SQL_INJECTION_RISK, CONSOLE_LOG_IN_PROD, UNSAFE_EVAL, TODO_FIXME, EMPTY_CATCH, ANY_TYPE_USAGE, COMPLEX_FUNCTION, NO_ERROR_HANDLING_ASYNC, CHILD_PROCESS_EXEC)
- ToolExecutionError encapsula falhas e audit registra por traceId

