const EVAL_COMMAND = 'dolly_command=$DOLLY_COMMAND; unset DOLLY_COMMAND; eval "$dolly_command"';

/**
 * The fixed script dolly-exec.py runs with `bash -lc`. The command itself travels in
 * DOLLY_COMMAND, so it never appears in a process's argv, where `pgrep -f`/`pkill -f`
 * patterns taken from the command would match (and kill) the wrapper. It stays POSIX:
 * a workspace restored from an older container snapshot still has a supervisor that
 * uses `sh -lc`, so outside bash it replaces itself (same PID and process group) with
 * a bash that evaluates the command.
 */
export const EXEC_SCRIPT = `[ -n "\${BASH_VERSION-}" ] || exec bash -c '${EVAL_COMMAND}'; ${EVAL_COMMAND}`;
