 # Athlete Tier Proposals — Pending Founder Review

**Status:** Draft. Do NOT add to `data/athlete-tiers.json` until the founder
has reviewed and approved this list. The v1 seed (20 athletes) in
`athlete-tiers.json` is sufficient for testing.

**Tier definitions:**
- **Tier 1:** Franchise stars, All-NBA/Pro Bowl-caliber, household names — national sports news when injured
- **Tier 2:** Reliable rotation starters whose injuries matter to their team's season — worth covering when the info is specific
- **Tier 3 (default):** Not listed — anyone absent from this file defaults to Tier 3
- **Tier 4:** Explicit depth/practice-squad entries to prevent T3 score inflation

Founder: please edit tier assignments as needed, mark deletions, and add missing names.
The goal is ~25 T1, ~50 T2, ~30 T4 per sport.

> **Two amendments from the 2026-08-13 audit** — read before editing tiers.
>
> **The ~25 T1 target predates the salary layer.** Salary alone now grants Tier 1
> to 54 NFL and 28 NBA athletes without any curation. The file's job is no longer
> to enumerate the tier-1 roster, only to correct salary where salary is wrong —
> so curated T1 counts of 33 (NFL) and 34 (NBA) are not an overshoot of that line.
>
> **The file is a FLOOR, never a ceiling.** It is consulted BEFORE salary, so an
> entry set below what an athlete is paid caps them there — curation acting as a
> penalty. That is what the audit found: 17 Tier 2 entries on athletes who had
> since signed Tier 1 contracts, while uncurated athletes on identical money were
> getting Tier 1 from salary automatically. Never leave an entry below its salary
> band; the correct direction to override in is upward (rookie deals,
> restructured veterans), which is the entire reason the file is authoritative.
>
> **Tier 4 does more than deprioritise, and entries are not deletable at will.**
> It sits above `thresholds.default.max_tier`, so BREAKING is DROPPED outright,
> not merely ranked lower. Deleting a Tier 4 entry therefore *expands* coverage —
> the athlete rises to the Tier 3 default and becomes scoreable. Likewise a Tier
> 1/2 entry is what keeps TRACKING alive (`require_tier_1_or_2` blocks Tier 3),
> so deleting one ends recovery-update coverage of that athlete's injury history.
> Entries for athletes who have left a roster are retained deliberately for both
> reasons. Audit before editing: `npx tsx src/scripts/tier-file-audit.ts`.

---

## NFL

### Tier 1 (franchise stars, ~25 players)

| Name | Team | Notes |
|---|---|---|
| Patrick Mahomes | Chiefs | |
| Josh Allen | Bills | |
| Lamar Jackson | Ravens | |
| Joe Burrow | Bengals | |
| Justin Jefferson | Vikings | |
| CeeDee Lamb | Cowboys | |
| Ja'Marr Chase | Bengals | |
| Tyreek Hill | Dolphins | |
| Tua Tagovailoa | Dolphins | |
| Brock Purdy | 49ers | |
| Jalen Hurts | Eagles | |
| Dak Prescott | Cowboys | |
| Jordan Love | Packers | |
| Anthony Richardson | Colts | |
| Caleb Williams | Bears | |
| Drake Maye | Patriots | |
| Saquon Barkley | Eagles | |
| Derrick Henry | Ravens | |
| Breece Hall | Jets | |
| Justin Herbert | Chargers | |
| Sam LaPorta | Lions | |
| Travis Kelce | Chiefs | |
| Christian McCaffrey | 49ers | |
| Davante Adams | Raiders | |
| Micah Parsons | Cowboys | |

### Tier 2 (rotation starters, ~50 players)

| Name | Team | Notes |
|---|---|---|
| Garrett Wilson | Jets | |
| Calvin Ridley | Titans | |
| DeVonta Smith | Eagles | |
| Stefon Diggs | Texans | |
| Keenan Allen | Bears | |
| Adam Thielen | Panthers | |
| Cooper Kupp | Rams | |
| Mike Evans | Buccaneers | |
| Chris Godwin | Buccaneers | |
| DK Metcalf | Seahawks | |
| Tyler Lockett | Seahawks | |
| Amari Cooper | Browns | |
| Jakobi Meyers | Raiders | |
| Evan Engram | Jaguars | |
| Sam LaPorta | Lions | Already in T1 — check |
| Tony Pollard | Titans | |
| Josh Jacobs | Packers | |
| Aaron Jones | Vikings | |
| Nick Chubb | Browns | Coming back from ACL — watch |
| Alvin Kamara | Saints | |
| Joe Mixon | Texans | |
| Raheem Mostert | Dolphins | |
| Kenneth Walker III | Seahawks | |
| Travis Etienne | Jaguars | |
| Tyjae Spears | Titans | |
| Puka Nacua | Rams | |
| Rome Odunze | Bears | |
| Zay Flowers | Ravens | |
| Tank Dell | Texans | |
| Quentin Johnston | Chargers | |
| Mark Andrews | Ravens | |
| Dalton Kincaid | Bills | |
| Cole Kmet | Bears | |
| Tee Higgins | Bengals | |
| Rashod Bateman | Ravens | |
| Dontayvion Wicks | Packers | |
| Jordan Addison | Vikings | |
| Jaxon Smith-Njigba | Seahawks | |
| Brian Thomas Jr. | Jaguars | |
| Jaylen Waddle | Dolphins | |
| Justin Watson | Chiefs | |
| Josh Downs | Colts | |
| Michael Pittman Jr. | Colts | |
| Wan'Dale Robinson | Giants | |
| Darius Slayton | Giants | |
| George Pickens | Steelers | |
| Calvin Austin III | Steelers | |
| Terry McLaurin | Commanders | |
| Dyami Brown | Commanders | |
| Chris Olave | Saints | |

### Tier 4 (depth/practice squad, ~30 players)

*Leave blank for now — founder to populate from roster knowledge.*

---

## NBA

### Tier 1 (franchise stars, ~25 players)

| Name | Team | Notes |
|---|---|---|
| Anthony Edwards | Timberwolves | |
| Nikola Jokic | Nuggets | |
| LeBron James | Lakers | |
| Stephen Curry | Warriors | |
| Jayson Tatum | Celtics | |
| Giannis Antetokounmpo | Bucks | |
| Joel Embiid | 76ers | Injury history makes T1 important |
| Luka Doncic | Mavericks | |
| Shai Gilgeous-Alexander | Thunder | |
| Donovan Mitchell | Cavaliers | |
| Jaylen Brown | Celtics | |
| Kevin Durant | Suns | |
| Devin Booker | Suns | |
| Damian Lillard | Bucks | |
| Karl-Anthony Towns | Knicks | |
| Jalen Brunson | Knicks | |
| Cade Cunningham | Pistons | |
| Paolo Banchero | Magic | |
| Franz Wagner | Magic | |
| Evan Mobley | Cavaliers | |
| Victor Wembanyama | Spurs | |
| Scottie Barnes | Raptors | |
| Zion Williamson | Pelicans | Injury archetype — high clinical interest |
| Brandon Ingram | Pelicans | |
| Trae Young | Hawks | |

### Tier 2 (rotation starters of playoff-caliber teams, ~50 players)

| Name | Team | Notes |
|---|---|---|
| Donte DiVincenzo | Timberwolves | |
| Moses Moody | Warriors | |
| Bam Adebayo | Heat | |
| De'Aaron Fox | Kings | |
| Draymond Green | Warriors | |
| Klay Thompson | Mavericks | |
| Kyle Kuzma | Wizards | |
| Mikal Bridges | Knicks | |
| OG Anunoby | Knicks | |
| Josh Hart | Knicks | |
| Darius Garland | Cavaliers | |
| Jarrett Allen | Cavaliers | |
| Isaac Okoro | Cavaliers | |
| Tyrese Haliburton | Pacers | |
| Myles Turner | Pacers | |
| Pascal Siakam | Pacers | |
| Andrew Nembhard | Pacers | |
| Tyrese Maxey | 76ers | |
| Kelly Oubre Jr. | 76ers | |
| Paul George | 76ers | |
| Tobias Harris | 76ers | |
| Anthony Davis | Lakers | T1 candidate — check |
| D'Angelo Russell | Lakers | |
| Austin Reaves | Lakers | |
| Cam Whitmore | Rockets | |
| Alperen Sengun | Rockets | |
| Jalen Green | Rockets | |
| Amen Thompson | Rockets | |
| Fred VanVleet | Rockets | |
| Dillon Brooks | Rockets | |
| Bobby Portis | Bucks | |
| Khris Middleton | Bucks | Injury history |
| Brook Lopez | Bucks | |
| Coby White | Bulls | |
| DeMar DeRozan | Kings | |
| Domantas Sabonis | Kings | |
| Keegan Murray | Kings | |
| Ben Simmons | Nets | |
| Cam Thomas | Nets | |
| Day'Ron Sharpe | Nets | |
| Josh Giddey | Bulls | |
| Zach LaVine | Bulls | Injury history |
| Nikola Vucevic | Bulls | |
| Jaren Jackson Jr. | Grizzlies | |
| Ja Morant | Grizzlies | T1 candidate — check |
| Desmond Bane | Grizzlies | |
| Mark Williams | Hornets | Tier 2 or 3? Founder call |
| LaMelo Ball | Hornets | T1 candidate — check |
| Miles Bridges | Hornets | |

### Tier 4 (two-way contracts, end-of-bench)

*Leave blank for now — founder to populate.*

---

## Review checklist for founder

- [ ] Verify T1 list: are there stars missing? Any T1 who should be T2?
- [ ] Mark Williams (NBA, Hornets): T2 or T3? (Determines if his foot fracture ever DEFERs vs. DROPs)
- [ ] LaMelo Ball: T1 or T2?
- [ ] Ja Morant: T1 or T2?
- [ ] Duplicate check: "Sam LaPorta" appears in both NFL T1 and T2 — pick one
- [ ] NFL T4 list: populate with specific practice squad / depth players you care about suppressing
- [ ] NBA T4 list: populate two-way contract players
- [ ] Confirm Calvin Ridley's current team (moved to Titans in 2024 but may have changed)
- [ ] Any active injury cases (Nick Chubb post-ACL, Zion Williamson) worth flagging specially?

Once approved, replace the 20-entry seed in `data/athlete-tiers.json` with this list.
Keep the format: `{ "name": "...", "sport": "NFL"|"NBA", "tier": 1|2|4 }`.

`team` was dropped in file v3 (2026-08-13). Nothing ever read it — the lookup
matches on name + sport — and it was stale on 68 of 189 rostered entries. It
could not even disambiguate two same-named athletes, because the lookup is
name-keyed and promotes both regardless. `src/scripts/tier-file-audit.ts`
reports such collisions instead.
