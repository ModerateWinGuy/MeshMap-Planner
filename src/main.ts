import { createApp } from 'vue';
// Bootstrap first, then our styles — style.css overrides Bootstrap's button/badge accents (the
// red/orange theme), and same-specificity overrides only win when they cascade *after* Bootstrap.
import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import App from './App.vue';
import { createPinia } from 'pinia';

const app = createApp(App);
app.use(createPinia());

app.mount('#app');
