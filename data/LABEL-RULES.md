# Labeling rules

One file, used by everyone who labels: the AI helpers who write the answer key, the second AI that labels blind, and anyone settling a disagreement. Written 11/21/2026, before any model call. Version 2: made clearer after the practice labeling, before any scored posting was labeled. Version 3 (11/22/2026, for version 2 of the build): written after version 1's results and its reviews had been seen, before any posting was labeled under it. Two changes: delivery the employer runs through outside carriers or delivery partners it manages counts as running deliveries; and logistics and transportation jobs are placed in question 2. Question 3 is no longer asked. All changes are listed in `CHANGES.md`.

You are given one job posting at a time: its title, its place, and its text split into numbered lines (`L001`, `L002`, ...). Answer two questions about it, and for question 1 list the lines that show your answer. Judge only from the title, the place and the text in front of you. Do not use anything you know about the company from elsewhere. Do not guess.

## Question 1. Does the employer itself run deliveries, routes, dispatch, a fleet or field visits?

Does the employer that wrote this posting deliver goods, run routes, dispatch drivers or technicians, keep a fleet of vehicles for that work, or send workers out to customers to install, repair, service, pick up or deliver things? It counts whether it does this with people or vehicles it employs or directs, or through outside carriers or delivery partners it chooses and manages.

| Answer | When |
|---|---|
| `yes` | The posting says the employer runs such an operation itself. This is still `yes` when the job in this posting is an office, management or software job, as long as the text says the employer runs the operation. A company whose business is moving goods for others (a carrier, a courier firm) is `yes`. Moving goods between separate sites of the employer (different addresses) is `yes`. Delivering the employer's own goods to its customers or between its sites through outside carriers or delivery partners that the employer chooses, schedules or manages is `yes`. |
| `no` | The posting shows the delivery-type words are about something else: software, data, products, projects, training, content, patient care, a driver's licence requirement, carrying passengers, dispatching workers who are not drivers or technicians (for example security officers), or moving things only inside one building, one lot, one base or one campus. And nothing in it says the employer runs deliveries, routes, dispatch, a fleet or field visits. |
| `not_said` | The posting does not say either way. Also `not_said` when the posting holds no delivery-type word at all and says nothing about such an operation. |

Boundary cases:
- A warehouse job (picking, packing, forklift) is `not_said` unless the text says the employer also delivers to customers with its own people or vehicles.
- Carrying people (rideshare, shuttles, resident or patient transport) is not delivering goods. If that is the only operation the posting shows, answer `no`.
- Clinical care at a patient's home (nursing, aides) is not a field visit. Travel to customers for training, consulting or project meetings is not a field visit either.
- A staffing or recruiting agency posting for a client: answer about the employer that will run the work, only if the text says so; otherwise `not_said`.
- Buying freight only for goods coming in from suppliers, with nothing about delivering to customers or between the employer's own sites, is `not_said`.

**Proof lines for question 1.** If the answer is `yes` or `no`, list every line whose own words support the answer. The title alone does not make a line qualify: a benefits line or a generic line does not count just because the title is clear. If only the title shows the answer and no line does, the list is empty. If the answer is `not_said`, the list is empty.

## Question 2. What would the person hired mainly do, day to day?

Judge the duties in the text, not only the title. Pick one.

| Answer | Means |
|---|---|
| `other` | None of the others: sales, marketing, finance, people team, recruiting (including recruiting drivers), customer support, training, clinical care, kitchen or shop-floor work, driving passengers, IT support, program or project management, and general or executive management outside delivery operations. |
| `software_or_data` | Builds or analyses software, data, products or designs, including on a team named delivery, logistics, dispatch or fleet. |
| `warehouse_or_store` | Picks, packs, stocks, loads or serves inside a warehouse, kitchen or store, with no driving to customers and no managing of drivers. A forklift driver is here. |
| `field_technician` | Travels to customers to install, repair, inspect or service something. |
| `fleet_management` | Looks after the vehicles or the drivers' compliance: buying, maintenance and repair of the employer's own vehicles (mechanics included), safety, DOT compliance, fleet records. |
| `delivery_operations_management` | Manages the delivery of goods: delivery, last-mile, logistics, transportation or driver teams, a delivery station, or outside carriers and delivery partners, without mainly driving or dispatching. "Service delivery" of a service or software is not this; it is `other` or `software_or_data`. |
| `dispatch_or_routing` | Assigns drivers or technicians to jobs, plans routes or loads, books carriers for shipments, or watches deliveries and jobs during the day. |
| `driving_or_courier` | Drives, rides or walks to deliver goods to customers or between sites, or drives a truck on a route to pick up or haul things for customers (for example junk removal, medical waste pick-up, towing). |

Boundary cases:
- A job that mixes warehouse work and delivery driving: `driving_or_courier` if the text says the person drives deliveries as a regular duty; otherwise `warehouse_or_store`.
- A job that mixes customer service and delivering a product to the customer's door (for example handing over a car): `driving_or_courier` if delivering is a main duty.
- A driver who moves vehicles or goods only inside a lot, a yard, a base or a campus: `warehouse_or_store`.
- A logistics or transportation job that mainly builds software or analyses data and reports: `software_or_data`. One that buys goods or manages suppliers rather than moving goods: `other`.

No proof lines for question 2.

## How to write your answers

One JSON object per posting, in one file, in this shape:

```json
{"posting_id": "…", "q1": "yes", "q1_lines": [3, 12], "q2": "driving_or_courier", "hard": ""}
```

- `q1_lines` are line numbers as plain numbers (3, not "L003").
- `hard`: one short sentence if the posting was hard to call and why; otherwise an empty string.
- Label every posting. Never leave one out. If you truly cannot decide between two answers, pick the one these rules favor and say why in `hard`.
