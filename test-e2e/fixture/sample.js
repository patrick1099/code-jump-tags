function alpha() {
  const total = compute(1, 2);
  return total;
}

function beta() {
  const total = compute(3, 4);
  return total;
}

function gamma() {
  let acc = 0;
  for (const n of [1, 2, 3]) {
    acc += n;
  }
  return acc;
}
