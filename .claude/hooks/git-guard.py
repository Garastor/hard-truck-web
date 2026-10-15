"""PreToolUse-хук для Bash: не дати закомітити чужі незакомічені файли.

У цій теці часто працюють кілька сесій Claude одночасно (наприклад, над різними іграми). Широке додавання (`git add -A`,
`git add .`, `git add -u`, `git add web/src` — ціла тека, `git commit -a`) захоплює й чужі правки. Голий `git stash` /
`git stash pop` може сховати чи забрати чужі зміни (стек спільний для всіх сесій і worktree).
Дозволено: `git add <конкретні файли>`, `git stash push -m …`, `git stash list|show|apply <sha>|drop`.
Вхід — JSON PreToolUse зі stdin; заборона — JSON з permissionDecision «deny» і поясненням.
"""
import json
import os
import re
import shlex
import sys

ADD_BROAD = {"-A", "--all", "-u", "--update", ".", ":/", "*"}


def reason_for(tokens: list[str], cwd: str) -> str | None:
    if len(tokens) < 2 or os.path.basename(tokens[0]) not in ("git", "git.exe"):
        return None
    # Пропустити глобальні опції git (-C <тека>, -c k=v, --no-pager…).
    i = 1
    while i < len(tokens) and tokens[i].startswith("-"):
        if tokens[i] in ("-C", "-c") and i + 1 < len(tokens):
            if tokens[i] == "-C":
                cwd = os.path.join(cwd, tokens[i + 1])
            i += 2
        else:
            i += 1
    if i >= len(tokens):
        return None
    cmd, args = tokens[i], tokens[i + 1 :]
    if cmd == "add":
        for a in args:
            if a in ADD_BROAD or re.fullmatch(r"-[a-zA-Z]*A[a-zA-Z]*", a):
                return f"`git add {a}` додає всі зміни робочої теки, зокрема чужі"
            if not a.startswith("-") and os.path.isdir(os.path.join(cwd, a)):
                return f"`git add {a}` додає цілу теку — там можуть бути чужі незакомічені файли"
    if cmd == "commit":
        for a in args:
            if a in ("-a", "--all") or re.fullmatch(r"-[a-zA-Z]*a[a-zA-Z]*", a) and not a.startswith("--"):
                return f"`git commit {a}` комітить усі змінені файли, зокрема чужі"
    if cmd == "stash":
        sub = args[0] if args else ""
        if sub in ("", "pop", "-u", "--include-untracked", "save") or (sub == "push" and "-m" not in args and "--message" not in args):
            return "голий `git stash` / `git stash pop` чіпає спільний для всіх сесій стек (можна сховати чи забрати чужі зміни)"
    return None


def main() -> None:
    data = json.load(sys.stdin)
    command = (data.get("tool_input") or {}).get("command") or ""
    cwd = data.get("cwd") or os.getcwd()
    # Розбити на окремі команди за && || ; | і переносами рядків.
    for part in re.split(r"&&|\|\||[;|\n]", command):
        try:
            tokens = shlex.split(part, posix=True)
        except ValueError:
            continue
        # cd <тека> на початку частини — врахувати для перевірки тек.
        if len(tokens) >= 2 and tokens[0] == "cd":
            cwd = os.path.join(cwd, tokens[1])
            continue
        why = reason_for(tokens, cwd)
        if why:
            json.dump(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": (
                            f"git-guard: {why}. У цій теці працюють кілька сесій — додавай лише свої файли поіменно "
                            "(`git status`, потім `git add <файл> <файл>`; після коміту — `git show --stat HEAD`). "
                            "Stash — лише `git stash push -m <мітка>` і `git stash apply <sha>`."
                        ),
                    }
                },
                sys.stdout,
                # \uXXXX — щоб текст не зіпсувало кодування консолі Windows.
                ensure_ascii=True,
            )
            return


if __name__ == "__main__":
    main()
