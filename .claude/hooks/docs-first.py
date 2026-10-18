"""UserPromptSubmit: нагадати Claude спершу прочитати документацію за темою завдання, а не досліджувати код заново.

Вхід — JSON події з полем "prompt"; вихід — additionalContext з документами, що пасують ключовим словам (основи слів,
нижній регістр). Без збігів — лише загальне нагадування. Помилки не блокують повідомлення.
"""
import json
import sys

# (основи слів у запиті, документ, про що)
TOPICS = [
    (("трафік", "трафик", "бот", "далекобій", "дальнобой", "автопілот", "автопилот", "перекид", "крен", "зигзаг",
      "обʼїзд", "об'їзд", "обгін", "дтп", "врізал", "911", "тупик", "перехрест", "смуг"),
     "Docs/ht2/traffic.md", "трафік, боти, автопілот, перекидання"),
    (("причеп", "причіп", "present", "баз", "ринок", "ринк", "парков", "найм", "продаж"),
     "Docs/ht2/traffic.md", "причепи на базах, ринки, найм (розд. 7)"),
    (("світл", "туман", "небо", "фар", "ніч", "освітл", "темн"), "Docs/ht2/lighting.md", "світло, туман, небо"),
    (("кабін", "салон", "голов", "дзеркал"), "Docs/ht2/cockpit.md", "вид із кабіни"),
    (("дим", "пар", "вихлоп", "частин", "вогон", "вибух", "іскр", "листя"), "Docs/ht2/effects.md", "дим, пара, частинки"),
    (("формат", "парсер", "way", "tech", ".sch", "ovl", "розшифр"), "Docs/ht2/formats.md", "формати HT2"),
    (("b3d", "перемикач"), "Docs/formats/b3d.md", "формат B3D"),
    (("міліц", "мафі", "рація", "раці", "гелікоптер", "табло", "сто ", "штраф"), "Docs/ht2/gameplay.md",
     "правила й інтерфейс оригіналу"),
    (("телефон", "iphone", "pwa", "мобіл"), "Docs/play-on-phone.md", "гра на телефоні"),
    (("мереж", "multiplayer", "webrtc"), "Docs/ht1/multiplayer.md", "мережева гра HT1"),
    (("структур", "архітектур", "залежност"), "Docs/09-structure-plan.md", "структура коду"),
]

GENERAL = (
    "Спершу документація, потім код (CLAUDE.md «Ключові документи», індекс Docs/README.md, реверс — "
    "re/notes/ht1|ht2/*.md): прочитай документ теми, перш ніж досліджувати код; після роботи доповни його, "
    "якщо чогось бракувало."
)


def main() -> None:
    try:
        prompt = str(json.loads(sys.stdin.buffer.read().decode("utf-8")).get("prompt", "")).lower()
    except Exception:
        return
    hits: list[str] = []
    for words, doc, what in TOPICS:
        if any(w in prompt for w in words):
            line = f"{doc} ({what})"
            if line not in hits:
                hits.append(line)
    text = GENERAL + (" Для цього завдання: " + "; ".join(hits) + "." if hits else "")
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}))


if __name__ == "__main__":
    main()
