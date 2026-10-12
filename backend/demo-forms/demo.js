// Demo-form behaviour (synthetic test targets).
// - Submitting shows what was submitted, so a test can prove the extension
//   never submits on its own (#submitted stays hidden until a human clicks).
// - On a data-controlled form the page keeps its own state, updated only by
//   input/change events — a value set without those events is invisible to it,
//   exactly like a React/Angular-controlled field.
(function () {
  const form = document.getElementById('demo-form');
  const submitted = document.getElementById('submitted');
  const stateView = document.getElementById('state');
  const controlled = form.dataset.controlled === 'true';
  const state = {};

  function render() {
    if (stateView) stateView.textContent = 'Page state (from events): ' + JSON.stringify(state, null, 2);
  }

  if (controlled) {
    const onEvent = (e) => {
      const el = e.target;
      if (!el.name) return;
      if (el.type === 'radio') {
        if (el.checked) state[el.name] = el.value;
      } else if (el.type === 'checkbox') {
        state[el.name] = el.checked;
      } else {
        state[el.name] = el.value;
      }
      render();
    };
    form.addEventListener('input', onEvent);
    form.addEventListener('change', onEvent);
    render();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = controlled ? state : Object.fromEntries(new FormData(form).entries());
    submitted.hidden = false;
    submitted.textContent = 'SUBMITTED ' + new Date().toISOString() + '\n' + JSON.stringify(data, null, 2);
    document.body.dataset.submitted = 'true';
  });
})();
