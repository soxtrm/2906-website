# Traffic coverage QA

## Coverage at audit time

| Measure | Strong | Moderate | Weak | No data |
| --- | ---: | ---: | ---: | ---: |
| Canonical directional road segments | 0 | 0 | 0 | All map roads |
| Segment × 15-minute cells | 0 | 0 | 0 | 100% |
| Segments reliable for all 96 slots | 0 | 0 | 0 | 100% |

The current 24 route keys describe anchor-to-anchor journeys rather than road segments. They cannot be painted onto streets without route geometry and a defensible directional mapping.

The internal QA layer should eventually use coverage states `HIGH`, `MEDIUM`, `LOW`, and `UNKNOWN`. At present every feature is `UNKNOWN`, so publishing a colored coverage map would add no information beyond this report.

## Scanner bias

The scanner deliberately samples 24 directional corridors across two alternating batches. It favors those named anchor pairs and does not sample Malta roads equally. Main-road usage is determined by the provider's chosen route. Because no polyline is retained, the roads selected by each response are unknown. Geographic, road-class, and street-level sampling bias cannot be quantified further.

The timer covered daytime and nighttime continuously after activation, with no gap over 20 minutes. That operational continuity does not repair the missing historical values.
