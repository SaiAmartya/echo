"""Canned data for Step 1 stubs. Replaced by real LLM calls in Step 2."""
from __future__ import annotations

NOTION_ARCHETYPES = [
    {"id": "pm",        "name": "Product managers",     "share": 28},
    {"id": "founders",  "name": "Founders",             "share": 21},
    {"id": "designers", "name": "Designers",            "share": 18},
    {"id": "engineers", "name": "Engineers",            "share": 16},
    {"id": "writers",   "name": "Writers / creators",   "share": 11},
    {"id": "critics",   "name": "Productivity critics", "share":  6},
]

CANNED_REPLIES = [
    {"initials": "AL", "name": "audrey lin",  "handle": "@audrey_lin",    "text": "killing toggles is a 'we know better than you' move. some of us live in 200-line docs and toggles are the only thing keeping them readable.", "sentiment": -0.42, "likely": 88, "archetype": "PM"},
    {"initials": "MR", "name": "m. reid",     "handle": "@mreid",         "text": "fewer primitives, more composition. this is the right call. the toggle was always a band-aid for outline view never shipping.",          "sentiment":  0.51, "likely": 81, "archetype": "Founder"},
    {"initials": "CN", "name": "caleb",       "handle": "@calebnotcaleb", "text": "is there a migration path for existing toggles or are we just supposed to flatten 4 years of notes by hand",                              "sentiment": -0.18, "likely": 76, "archetype": "PM"},
    {"initials": "JV", "name": "jules verne", "handle": "@jverne",        "text": "every notion redesign: 'cleaner mental model.' every notion redesign: now i can't find the thing.",                                          "sentiment": -0.34, "likely": 72, "archetype": "Critic"},
    {"initials": "TK", "name": "tia k.",      "handle": "@tiakwrites",    "text": "i'll thank you in a week if my templates don't break. genuine question, not a dunk.",                                                        "sentiment":  0.06, "likely": 64, "archetype": "Writer"},
    {"initials": "SP", "name": "s. pham",     "handle": "@sphamsf",       "text": "the confidence on 'you'll thank us' is doing some heavy lifting here",                                                                       "sentiment": -0.22, "likely": 58, "archetype": "Designer"},
]

CANNED_FLAGS = [
    {"title": "\"You'll thank us\" reads as condescending", "detail": "~31% of your audience flags this phrase as dismissive. Try \"we think this is the right tradeoff\" instead."},
    {"title": "No migration story",                          "detail": "14 of the top 20 likely repliers ask about existing toggles. Pre-empting this would lower predicted ratio risk by ~22%."},
]

CANNED_REWRITE = (
    "we're rethinking toggles. inline blocks first, with a migration path for existing docs. "
    "early access next week — link below."
)
