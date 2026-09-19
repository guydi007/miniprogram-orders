import { createRouter, createWebHashHistory } from 'vue-router'
import { session } from './stores/session'
import LoginView from './views/LoginView.vue'
import LayoutView from './views/LayoutView.vue'
import OrdersView from './views/OrdersView.vue'
import CreateOrderView from './views/CreateOrderView.vue'
import OrderDetailView from './views/OrderDetailView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    {
      path: '/',
      component: LayoutView,
      children: [
        { path: '', redirect: '/orders' },
        { path: 'orders', component: OrdersView },
        { path: 'orders/:id', component: OrderDetailView },
        { path: 'create', component: CreateOrderView, meta: { roles: ['service', 'leader'] } }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/orders' }
  ]
})

router.beforeEach(async to => {
  if (to.meta.public) {
    const user = await session.hydrate()
    if (user) return '/orders'
    return true
  }
  const user = await session.hydrate()
  if (!user) return { path: '/login', query: { redirect: to.fullPath } }
  const roles = to.meta.roles
  if (roles && !roles.includes(user.role)) return '/orders'
  return true
})

export default router
