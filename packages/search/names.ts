import { foldSearchText } from "./query.ts";

// Lexikon křestních jmen, nikoli seznam podporovaných dvojic osob. Neznámé jméno
// zůstává přísným dotazem; databázový katalog osob lexikon dále rozšiřuje.
const givenNames = `Adam Adolf Alan Albert Alexander Alexandr Alex Andrej Andrew Angela Anna
Antonín Barack Benjamin Bill Boris Bohdan Bohumil David Daniel Denis Donald Dominik Eduard
Elon Emmanuel Erik Eva Filip František George Hana Hillary Igor Ivan Ivana Jakub Jan Jana
Jaromír Jaroslav Jiří Joe John Josef Julia Julie Kamala Karel Kateřina Kevin Klára Klaus
Kristian Lenka Leo Leonid Lucie Luděk Lukáš Marek Maria Marie Martin Martina Matěj Michael
Michal Milan Miloš Miroslav Monika Nancy Nicole Olaf Ondřej Patrik Paul Pavel Pavla Peter
Petr Petra Radek Richard Robert Roman Ronald Rudolf Sergej Stanislav Stephen Steve Steven
Susan Sylvie Tereza Thomas Tomáš Ursula Václav Viktor Vladimir Vladimír Volodymyr Walter
William Zbyněk Zdeněk Zuzana`.split(/\s+/u);

function variants(name: string): string[] {
  const n = foldSearchText(name);
  const forms = new Set([n]);
  if (n.endsWith("a")) {
    for (const ending of ["a", "y", "e", "u", "ou", "o", "ovi", "em"]) {
      forms.add(n.slice(0, -1) + ending);
    }
  } else if (n.endsWith("o")) {
    for (const ending of ["a", "ovi", "em"]) forms.add(n.slice(0, -1) + ending);
  } else if (!/[eiouy]$/.test(n)) {
    for (const ending of ["a", "u", "e", "ovi", "em"]) forms.add(n + ending);
    // Petr -> Petra, Pavel -> Pavla, Marek -> Marka, Zdeněk -> Zdeňka.
    if ((n.length <= 5 && n.endsWith("el")) || n.endsWith("ek")) {
      const stem = n.slice(0, -2) + n.slice(-1);
      for (const ending of ["a", "u", "e", "ovi", "em"]) forms.add(stem + ending);
    }
  }
  return [...forms];
}

function surnameForms(name: string, allowFeminine = false): string[] {
  const n = foldSearchText(name);
  if (n.endsWith("ova")) return [n, n.slice(0, -1) + "ou", n.slice(0, -1) + "e"];
  if (n.endsWith("y")) {
    return [n, n.slice(0, -1) + "eho", n.slice(0, -1) + "emu", n.slice(0, -1) + "ym"];
  }
  return [
    ...new Set([...variants(n), ...(allowFeminine ? [n + "ova", n + "ovou", n + "ove"] : [])]),
  ];
}

export interface NameQuery {
  given: string;
  givenForms: string[];
  surname: string;
  surnameQuery: string;
  fullPattern: string;
  surnamePattern: string;
  mentionsPattern: string;
  canonicalGiven: ReadonlyMap<string, string>;
}

/** Rozšíření se nikdy neodvozuje jen z velkého písmena nebo posledního slova tématu. */
export function nameQuery(query: string, knownPeople: string[] = []): NameQuery | null {
  const lexicon = new Map<string, string>();
  const registered = knownPeople.flatMap((person) => {
    const parts = foldSearchText(person).match(/[a-z]+/g) ?? [];
    return parts.length === 2 ? [parts[0]!] : [];
  });
  for (const given of [...givenNames, ...registered]) {
    lexicon.set(foldSearchText(given), foldSearchText(given));
  }
  for (const given of [...givenNames, ...registered]) {
    for (const form of variants(given)) {
      if (!lexicon.has(form)) lexicon.set(form, foldSearchText(given));
    }
  }
  const parts = foldSearchText(query).match(/[a-z]+/g) ?? [];
  if (parts.length !== 2 || !/^[\p{L}\s]+$/u.test(query)) return null;
  const given = lexicon.get(parts[0]!);
  if (!given || parts[1]!.length < 3) return null;
  const allowFeminine = given.endsWith("a");
  // U celých jmen z katalogu známe i základní tvar příjmení.
  const registeredSurname = knownPeople.map((person) => foldSearchText(person).split(/\s+/u))
    .find((person) =>
      person.length === 2 && lexicon.get(person[0]!) === given &&
      surnameForms(person[1]!, allowFeminine).includes(parts[1]!)
    )?.[1];
  let surname = registeredSurname ?? parts[1]!;
  // Zjevné české pádové přípony lze normalizovat bez zkracování libovolných slov.
  if (!registeredSurname && surname.endsWith("ovou")) surname = surname.slice(0, -4) + "ova";
  if (!registeredSurname && surname.endsWith("ovi")) surname = surname.slice(0, -3);
  const possibleBases = [surname];
  if (!registeredSurname && /[aeu]$/.test(surname) && surname.length > 4) {
    possibleBases.push(surname.slice(0, -1));
  }
  if (!registeredSurname && surname.endsWith("y")) possibleBases.push(surname.slice(0, -1) + "a");
  const surnames = [...new Set(possibleBases.flatMap((base) => surnameForms(base, allowFeminine)))];
  const surnameGroup = `(${surnames.join("|")})`;
  const givenForms = variants(given);
  return {
    given,
    givenForms,
    surname,
    surnameQuery: surnames.join(" | "),
    fullPattern: `\\m(${givenForms.join("|")})[[:space:]]+${surnameGroup}\\M`,
    surnamePattern: `\\m${surnameGroup}\\M`,
    // Databáze jen vytáhne předchozí slovo; lexikon ověříme nad malým výsledkem
    // v resolveName. Stovky alternativ v SQL regexu výrazně prodražují skenování.
    mentionsPattern: `\\m([a-z]+)[[:space:]]+${surnameGroup}\\M`,
    canonicalGiven: lexicon,
  };
}
