# Requirements: Tip Calculator

## P0 — Core (weight: 0.60)

### Task 1: Basic tip calculation

- type: computation
- goal: Calculate a 20% tip on a $50.00 bill
- success_criteria:
  - Tip amount of $10.00 is displayed
  - Total with tip ($60.00) is displayed
- evaluation_method: task_completion
- correct_answer: Tip: $10.00, Total: $60.00

### Task 2: Bill splitting

- type: computation
- goal: Calculate a 20% tip on an $85.00 bill and split the total evenly between 3 people
- success_criteria:
  - Per-person amount is displayed
  - Amount is approximately $34.00
- evaluation_method: task_completion
- correct_answer: $34.00 per person

## P1 — Important (weight: 0.25)

### Task 3: Handle bad input

- type: navigation
- goal: Enter "abc" as the bill amount and see what happens
- success_criteria:
  - App does not crash or show blank/broken page
  - Some kind of error feedback is shown to the user
- evaluation_method: output_review

### Task 4: Custom tip percentage

- type: computation
- goal: Calculate a 25% tip on a $40.00 bill
- success_criteria:
  - Tip amount of $10.00 is displayed
  - User can choose or enter a custom tip percentage
- evaluation_method: task_completion
- correct_answer: Tip: $10.00, Total: $50.00

## P2 — Nice to have (weight: 0.15)

### Task 5: Suggested tip amounts

- type: navigation
- goal: See quick-select buttons for common tip percentages (15%, 18%, 20%, 25%)
- success_criteria:
  - At least 3 preset tip percentage options are visible without scrolling
  - Clicking one calculates the tip without needing to type the percentage
- evaluation_method: output_review

### Task 6: Compare tip options to decide

- type: computation
- goal: You have a $120 bill split 4 ways. Compare what each person would pay at 15%, 18%, and 20% tip to decide which to suggest to the group
- success_criteria:
  - Per-person amounts for at least two different tip percentages are visible simultaneously or easy to compare
  - User can switch between options without re-entering the bill amount and split count
- evaluation_method: output_review

## Scoring

composite = (p0_score * 0.60) + (p1_score * 0.25) + (p2_score * 0.15)
If any P0 task scores 0: composite = min(composite, 40)

Per-task scoring:

- task_completion: 100 if completed, 0 if not. Penalty of -2 per step beyond 5.
- output_review: 0-100 based on success_criteria met, evaluated by LLM.
