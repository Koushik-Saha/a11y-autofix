<!--
  Vue counterpart of LabelInsertNoId.tsx: a bare <input> with no id. In a
  template the label points at it with `for`, not `htmlFor`.
-->
<template>
  <form>
    <h2>Newsletter</h2>
    <input type="email" name="email" />
    <button type="submit">Subscribe</button>
  </form>
</template>
