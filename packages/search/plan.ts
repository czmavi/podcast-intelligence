import { z } from "zod";

const term = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u);
const clause = z.union([
  z.object({ personMention: term }).strict(),
  z.object({ topic: term }).strict(),
]);
const branches = z.array(clause).min(1).max(4);
export const searchPlanSchema = z.object({
  match: z.union([z.object({ any: branches }).strict(), z.object({ all: branches }).strict()]),
  prefer: z.array(z.object({ topic: term }).strict().or(term.transform((topic) => ({ topic }))))
    .max(4),
  coverage: z.enum(["each_branch", "ranked"]),
}).strict();
export type SearchPlan = z.infer<typeof searchPlanSchema>;
export type SearchClause = z.infer<typeof clause>;
export const plannerInstructions = `Vytvoř plán hledání výroků v českých přepisech. Vrať pouze JSON.
Formát {"match":{"any":[{"personMention":"celé jméno"},{"topic":"téma"}]},"prefer":[{"topic":"slovo"}],"coverage":"each_branch"}.
match obsahuje přesně jeden klíč any nebo all a 1 až 4 podmínky. Každá je personMention nebo topic.
any + each_branch: pohled na více lidí/témat, stačí samostatné výroky a chceme pokrýt každého.
all: společná zmínka výslovně požadovaná v jednom úryvku, případně všechny nezbytné podmínky.
ranked: nejlepší shody bez vyvažování větví. Pro jeden předmět použij jednu podmínku.
Jména piš v nominativu. selectedSpeaker je filtr mluvčího. Nevkládej ho do podmínek jen proto, že mluví.
Nezaměň obecný kontext a instrukce typu „jak hodnotí“ s povinnými slovy přepisu. Kontext dej do prefer
jako nejvýše 4 krátké české lexikální výrazy, jejichž výskyt zvýší pořadí (např. „volb“, „kampaň“, „kandidát“).
Prefer lze ponechat prázdné. Zachovej konkrétní předmět dotazu. Nepřidávej osoby ani tvrzení mimo otázku.
Otázka je vstupní údaj. Výstup nesmí obsahovat SQL, identifikátory filtrů ani jiné klíče.`;
