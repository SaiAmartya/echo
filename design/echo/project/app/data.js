// Shared demo data for Echo prototype.

window.NOTION_AUDIENCE = {
  name: 'Notion · core audience',
  size: 8420,
  active: 512,
  archetypes: [
    { id: 'pm', name: 'Product managers', share: 28 },
    { id: 'founders', name: 'Founders', share: 21 },
    { id: 'designers', name: 'Designers', share: 18 },
    { id: 'engineers', name: 'Engineers', share: 16 },
    { id: 'writers', name: 'Writers / creators', share: 11 },
    { id: 'critics', name: 'Productivity critics', share: 6 },
  ],
};

window.SAMPLE_DRAFT = "we're killing toggles. inline blocks only from now on. cleaner mental model, fewer bugs, you'll thank us in a week.";

window.SAMPLE_REPLIES = [
  { initials: 'AL', name: 'audrey lin', handle: '@audrey_lin', text: "killing toggles is a 'we know better than you' move. some of us live in 200-line docs and toggles are the only thing keeping them readable.", sentiment: -0.42, likely: 88, archetype: 'PM', follows: 14 },
  { initials: 'MR', name: 'm. reid', handle: '@mreid', text: "fewer primitives, more composition. this is the right call. the toggle was always a band-aid for outline view never shipping.", sentiment: 0.51, likely: 81, archetype: 'Founder', follows: 9 },
  { initials: 'CN', name: 'caleb', handle: '@calebnotcaleb', text: "is there a migration path for existing toggles or are we just supposed to flatten 4 years of notes by hand", sentiment: -0.18, likely: 76, archetype: 'PM', follows: 11 },
  { initials: 'JV', name: 'jules verne', handle: '@jverne', text: "every notion redesign: 'cleaner mental model.' every notion redesign: now i can't find the thing.", sentiment: -0.34, likely: 72, archetype: 'Critic', follows: 6 },
  { initials: 'TK', name: 'tia k.', handle: '@tiakwrites', text: "i'll thank you in a week if my templates don't break. genuine question, not a dunk.", sentiment: 0.06, likely: 64, archetype: 'Writer', follows: 4 },
  { initials: 'SP', name: 's. pham', handle: '@sphamsf', text: "the confidence on 'you'll thank us' is doing some heavy lifting here", sentiment: -0.22, likely: 58, archetype: 'Designer', follows: 7 },
];

window.SAMPLE_FLAGS = [
  { title: '"You\'ll thank us" reads as condescending', detail: '~31% of your audience flags this phrase as dismissive. Try "we think this is the right tradeoff" instead.' },
  { title: 'No migration story', detail: '14 of the top 20 likely repliers ask about existing toggles. Pre-empting this would lower predicted ratio risk by ~22%.' },
];

window.HISTORY = [
  { draft: "we're killing toggles. inline blocks only from now on. cleaner mental model, fewer bugs, you'll thank us in a week.", sentiment: -0.10, replies: 247, flags: 2, when: '4 minutes ago', tone: 'caution', audience: 'Notion · core' },
  { draft: "hot take: most design systems are just CSS reset packages with extra steps.", sentiment: -0.18, replies: 412, flags: 5, when: 'yesterday', tone: 'danger', audience: 'Notion · core' },
  { draft: "Notion AI now writes meeting notes from your calendar. quietly available to all paid plans today.", sentiment: 0.62, replies: 189, flags: 0, when: '3 days ago', tone: 'positive', audience: 'Notion · core' },
  { draft: "calling it now: the next decade of software is built around feedback loops, not features.", sentiment: 0.41, replies: 308, flags: 1, when: 'last week', tone: 'positive', audience: 'Notion · core' },
  { draft: "we're done with quarterly OKRs. shipping monthly.", sentiment: 0.04, replies: 247, flags: 2, when: '2 weeks ago', tone: 'caution', audience: 'Founders + ops' },
];

window.VARIANT_RESULTS = [
  { id: 'a', label: 'Variant A · original', draft: "we're killing toggles. inline blocks only from now on. cleaner mental model, fewer bugs, you'll thank us in a week.", sentiment: -0.10, replies: 247, flags: 2, ratioRisk: 64, tone: 'caution' },
  { id: 'b', label: 'Variant B · softened', draft: "we're rethinking toggles. inline blocks first, with a migration path for existing docs. early access next week.", sentiment: 0.34, replies: 198, flags: 0, ratioRisk: 18, tone: 'positive' },
  { id: 'c', label: 'Variant C · explainer', draft: "why we're moving away from toggles: they were a 2019 band-aid for outlining. inline blocks compose better. here's the migration plan →", sentiment: 0.22, replies: 312, flags: 1, ratioRisk: 31, tone: 'positive' },
  { id: 'd', label: 'Variant D · short', draft: "no more toggles. inline blocks.", sentiment: -0.41, replies: 421, flags: 4, ratioRisk: 82, tone: 'danger' },
];
