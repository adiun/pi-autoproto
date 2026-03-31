# Requirements: Tip Calculator

## P0 — Core (weight: 0.60)

### Task 1: Quick split after a long shift

- type: computation
- goal: The bill is $85.00. You and 2 coworkers want to split it evenly with 20% tip. Get each person's amount as fast as possible — you're exhausted and just want to Venmo and leave.
- success_criteria:
  - Per-person amount is displayed and approximately $34.00
  - The persona reached the answer without re-entering data or doing mental math
  - The flow felt fast (3 taps or fewer after entering the bill)
- evaluation_method: output_review

### Task 2: Uneven split with drinks

- type: computation
- goal: The bill is $120.00 split 4 ways, but 2 people had cocktails ($15 each) and 2 didn't. Everyone agrees on 20% tip. Figure out a fair split where the drinkers pay more. What does each person owe?
- success_criteria:
  - The persona found a way to handle the uneven split (not just $120/4)
  - The persona articulated what each person owes, or explained what the app couldn't do
  - If the app doesn't support uneven splits, the persona's feedback describes the gap clearly
- evaluation_method: output_review

## P1 — Important (weight: 0.25)

### Task 3: Settle the tip debate

- type: navigation
- goal: Someone at the table suggests 15% tip, but you think that's low for a sit-down meal. Use the app to show the group the difference between 15%, 18%, and 20% on your $85 bill split 3 ways — make the case for 20% without doing mental math.
- success_criteria:
  - The persona can compare at least two tip percentages without re-entering the bill
  - The per-person difference between options is visible or easy to articulate
  - The persona could use this as a persuasion tool ("it's only $X more per person")
- evaluation_method: output_review

### Task 4: Handle bad input

- type: navigation
- goal: Enter "abc" as the bill amount and see what happens
- success_criteria:
  - App does not crash or show blank/broken page
  - Some kind of error feedback is shown to the user
- evaluation_method: output_review

## P2 — Nice to have (weight: 0.15)

### Task 5: Pre-tax tip

- type: computation
- goal: Your coworker points out the $85 bill includes $6.50 in tax and you shouldn't tip on tax. Figure out the tip on the pre-tax amount ($78.50) at 20% and what that changes for each person's share split 3 ways.
- success_criteria:
  - The persona found a way to calculate tip on a pre-tax amount
  - The difference from the tax-included calculation is visible or articulable
  - If the app doesn't support pre-tax, the persona's feedback describes the frustration
- evaluation_method: output_review

### Task 6: Quick preset for the usual

- type: navigation
- goal: See quick-select buttons for common tip percentages (15%, 18%, 20%, 25%). Pick 20% without typing.
- success_criteria:
  - At least 3 preset tip percentage options are visible without scrolling
  - Clicking one calculates the tip without needing to type the percentage
- evaluation_method: output_review

## Scoring

composite = (p0_score * 0.60) + (p1_score * 0.25) + (p2_score * 0.15)
If any P0 task scores 0: composite = min(composite, 40)

Per-task scoring:

- task_completion: 100 if completed, 0 if not. Penalty of -2 per step beyond 5.
- output_review: 0-100 based on success_criteria met, evaluated by LLM.
