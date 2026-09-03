import { Component, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { LedgerProvider } from './components/LedgerProvider'
import { ErrorState } from './components/ui'
import { Dashboard } from './pages/Dashboard'
import { Transactions } from './pages/Transactions'
import { AddTransaction } from './pages/AddTransaction'
import { ReviewQueue } from './pages/ReviewQueue'
import { Cards } from './pages/Cards'
import { AddCard } from './pages/AddCard'
import { Access } from './pages/Access'
import { CardDetail } from './pages/CardDetail'

/** A failed render must never show a half-drawn balance. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-10">
          <ErrorState
            title="Something went wrong rendering this page"
            detail={this.state.error.message}
            onRetry={() => this.setState({ error: null })}
          />
        </div>
      )
    }
    return this.props.children
  }
}

export function App() {
  return (
    <Boundary>
      <BrowserRouter>
        <LedgerProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="add" element={<AddTransaction />} />
            <Route path="review" element={<ReviewQueue />} />
            <Route path="cards" element={<Cards />} />
            <Route path="cards/new" element={<AddCard />} />
            <Route path="access" element={<Access />} />
            <Route path="cards/:id" element={<CardDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </LedgerProvider>
      </BrowserRouter>
    </Boundary>
  )
}
