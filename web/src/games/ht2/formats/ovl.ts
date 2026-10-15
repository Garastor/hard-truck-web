/**
 * Кластери ресурсів Дальнобойщиків 2 (`*.OVL`, текст): `CLUSTER <імʼя>`, далі рядки з іменами файлів архіву
 * (`txr\Fiat_all1.txr`, `abot_a.msk`), `END`. Групи текстур однієї моделі — для вибіркового завантаження.
 */
export function parseOvl(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^CLUSTER\s+(\S+)/i.exec(line);
    if (m) {
      cur = [];
      out.set(m[1], cur);
    } else if (/^END$/i.test(line)) cur = null;
    else if (cur) cur.push(line.split(/\s+/)[0].replace(/\\/g, '/').toLowerCase());
  }
  return out;
}
