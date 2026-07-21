import { createFileRoute, Outlet } from '@tanstack/react-router'

// /app/coach 是 layout：儀表板本身在 app.coach.index.tsx，
// 成員細節頁 app.coach.member.$id.tsx 透過這裡的 <Outlet /> 渲染。
export const Route = createFileRoute('/app/coach')({
  component: CoachLayout,
})

function CoachLayout() {
  return <Outlet />
}
