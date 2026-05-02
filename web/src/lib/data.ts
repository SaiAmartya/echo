export type Reply = {
  initials: string;
  name: string;
  handle: string;
  text: string;
  sentiment: number;
  likely: number;
  archetype: string;
  follows?: number;
};

export type Flag = { title: string; detail: string };

export type Run = {
  draft: string;
  sentiment: number;
  replies: number;
  flags: number;
  when: string;
  tone: "positive" | "caution" | "danger";
  audience: string;
};

export const SAMPLE_DRAFT =
  "we're killing toggles. inline blocks only from now on. cleaner mental model, fewer bugs, you'll thank us in a week.";

export const SAMPLE_REPLIES: Reply[] = [
  { initials: "AL", name: "audrey lin", handle: "@audrey_lin", text: "killing toggles is a 'we know better than you' move. some of us live in 200-line docs and toggles are the only thing keeping them readable.", sentiment: -0.42, likely: 88, archetype: "PM", follows: 14 },
  { initials: "MR", name: "m. reid", handle: "@mreid", text: "fewer primitives, more composition. this is the right call. the toggle was always a band-aid for outline view never shipping.", sentiment: 0.51, likely: 81, archetype: "Founder", follows: 9 },
  { initials: "CN", name: "caleb", handle: "@calebnotcaleb", text: "is there a migration path for existing toggles or are we just supposed to flatten 4 years of notes by hand", sentiment: -0.18, likely: 76, archetype: "PM", follows: 11 },
  { initials: "JV", name: "jules verne", handle: "@jverne", text: "every notion redesign: 'cleaner mental model.' every notion redesign: now i can't find the thing.", sentiment: -0.34, likely: 72, archetype: "Critic", follows: 6 },
  { initials: "TK", name: "tia k.", handle: "@tiakwrites", text: "i'll thank you in a week if my templates don't break. genuine question, not a dunk.", sentiment: 0.06, likely: 64, archetype: "Writer", follows: 4 },
  { initials: "SP", name: "s. pham", handle: "@sphamsf", text: "the confidence on 'you'll thank us' is doing some heavy lifting here", sentiment: -0.22, likely: 58, archetype: "Designer", follows: 7 },
];

export const SAMPLE_FLAGS: Flag[] = [
  { title: "\"You'll thank us\" reads as condescending", detail: "~31% of your audience flags this phrase as dismissive. Try \"we think this is the right tradeoff\" instead." },
  { title: "No migration story", detail: "14 of the top 20 likely repliers ask about existing toggles. Pre-empting this would lower predicted ratio risk by ~22%." },
];

export const HISTORY: Run[] = [
  { draft: "we're killing toggles. inline blocks only from now on. cleaner mental model, fewer bugs, you'll thank us in a week.", sentiment: -0.10, replies: 247, flags: 2, when: "4 minutes ago", tone: "caution", audience: "Notion · core" },
  { draft: "hot take: most design systems are just CSS reset packages with extra steps.", sentiment: -0.18, replies: 412, flags: 5, when: "yesterday", tone: "danger", audience: "Notion · core" },
  { draft: "Notion AI now writes meeting notes from your calendar. quietly available to all paid plans today.", sentiment: 0.62, replies: 189, flags: 0, when: "3 days ago", tone: "positive", audience: "Notion · core" },
  { draft: "calling it now: the next decade of software is built around feedback loops, not features.", sentiment: 0.41, replies: 308, flags: 1, when: "last week", tone: "positive", audience: "Notion · core" },
  { draft: "we're done with quarterly OKRs. shipping monthly.", sentiment: 0.04, replies: 247, flags: 2, when: "2 weeks ago", tone: "caution", audience: "Founders + ops" },
];
