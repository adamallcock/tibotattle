/** Opt-in local qualification reporter. Only the closed, content-free test
 * measurement object is emitted, and only after its assertions all pass. */
export default class CalculatorScaleReporter {
  onTestCaseResult(test) {
    if (test.result().state !== "passed") return;
    const measurement = test.meta().calculatorScale;
    if (measurement?.event === "synthetic_calculator_scale") {
      process.stdout.write(`${JSON.stringify(measurement)}\n`);
    }
  }
}
