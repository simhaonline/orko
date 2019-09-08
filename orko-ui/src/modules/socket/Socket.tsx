/*
 * Orko
 * Copyright © 2018-2019 Graham Crockford
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import React, {
  useEffect,
  ReactElement,
  useContext,
  useState,
  useMemo,
  useRef,
  useCallback
} from "react"

import { AuthContext } from "@orko-ui-auth/Authoriser"

import * as coinActions from "../../store/coin/actions"
import * as notificationActions from "../../store/notifications/actions"
import * as socketClient from "../../worker/socket.client.js"
import * as tickerActions from "../../store/ticker/actions"
import { locationToCoin } from "../../selectors/coins"
import { batchActions } from "redux-batched-actions"
import { useInterval } from "util/hookUtils"
import { SocketContext, SocketApi } from "./SocketContext"

const ACTION_KEY_ORDERBOOK = "orderbook"
const ACTION_KEY_BALANCE = "balance"
const ACTION_KEY_TICKER = "ticker"

export interface SocketProps {
  store
  history
  children: ReactElement
}

const Socket: React.FC<SocketProps> = (props: SocketProps) => {
  const auth = useContext(AuthContext)
  const [connected, setConnected] = useState(false)
  const previousCoin = useRef<object>()

  const deduplicatedActionBuffer = useRef<object>()
  useEffect(() => {
    deduplicatedActionBuffer.current = {}
  }, [])

  const allActionBuffer = useRef<Array<object>>()
  useEffect(() => {
    allActionBuffer.current = []
  }, [])

  const subscribedCoins = useCallback(
    () => props.store.getState().coins.coins,
    [props.store]
  )
  const selectedCoin = useCallback(
    () => locationToCoin(props.store.getState().router.location),
    [props.store]
  )

  function bufferLatestAction(key, action) {
    deduplicatedActionBuffer.current[key] = action
  }

  function bufferAllActions(action: object) {
    allActionBuffer.current.push(action)
  }

  function clearActionsForPrefix(prefix: string) {
    // eslint-disable-next-line
    for (const key of Object.keys(deduplicatedActionBuffer.current)) {
      if (key.startsWith(prefix)) delete deduplicatedActionBuffer.current[key]
    }
  }

  const resubscribe = useCallback(() => {
    socketClient.changeSubscriptions(subscribedCoins(), selectedCoin())
    socketClient.resubscribe()
  }, [subscribedCoins, selectedCoin])

  // Buffer and dispatch as a batch all the actions from the socket once a second
  useInterval(() => {
    const batch = Object.values(deduplicatedActionBuffer.current).concat(
      allActionBuffer
    )
    deduplicatedActionBuffer.current = {}
    allActionBuffer.current = []
    props.store.dispatch(batchActions(batch))
  }, 1000)

  // When the coin selected changes, send resubscription messages and clear any
  // coin-specific state
  useEffect(() => {
    props.history.listen(location => {
      const coin = locationToCoin(location)
      if (coin !== previousCoin.current) {
        previousCoin.current = coin
        console.log("Resubscribing following coin change")
        socketClient.changeSubscriptions(subscribedCoins(), coin)
        socketClient.resubscribe()
        clearActionsForPrefix(ACTION_KEY_BALANCE)
        bufferLatestAction(ACTION_KEY_ORDERBOOK, coinActions.setOrderBook(null))
        bufferAllActions(coinActions.clearUserTrades())
        props.store.dispatch(coinActions.clearOrders())
        bufferAllActions(coinActions.clearTrades())
        bufferAllActions(coinActions.clearBalances())
      }
    })
  }, [props.store, props.history, connected, subscribedCoins])

  // Forward direct notifications to the store
  useEffect(() => {
    socketClient.onError(message =>
      props.store.dispatch(notificationActions.localError(message))
    )
    socketClient.onNotification(message =>
      props.store.dispatch(notificationActions.add(message))
    )
    socketClient.onStatusUpdate(message =>
      props.store.dispatch(notificationActions.statusUpdate(message))
    )
  }, [props.store])

  // Dispatch market data to the store
  useEffect(() => {
    const sameCoin = (left, right) => left && right && left.key === right.key
    socketClient.onTicker((coin, ticker) =>
      bufferLatestAction(
        ACTION_KEY_TICKER + "/" + coin.key,
        tickerActions.setTicker(coin, ticker)
      )
    )
    socketClient.onBalance((exchange, currency, balance) => {
      const coin = selectedCoin()
      if (
        coin &&
        coin.exchange === exchange &&
        (coin.base === currency || coin.counter === currency)
      ) {
        bufferLatestAction(
          ACTION_KEY_BALANCE + "/" + exchange + "/" + currency,
          coinActions.setBalance(exchange, currency, balance)
        )
      }
    })
    socketClient.onOrderBook((coin, orderBook) => {
      if (sameCoin(coin, selectedCoin()))
        bufferLatestAction(
          ACTION_KEY_ORDERBOOK,
          coinActions.setOrderBook(orderBook)
        )
    })
    socketClient.onTrade((coin, trade) => {
      if (sameCoin(coin, selectedCoin()))
        bufferAllActions(coinActions.addTrade(trade))
    })
    socketClient.onUserTrade((coin, trade) => {
      if (sameCoin(coin, selectedCoin()))
        bufferAllActions(coinActions.addUserTrade(trade))
    })
    socketClient.onOrderUpdate((coin, order, timestamp) => {
      if (sameCoin(coin, selectedCoin()))
        props.store.dispatch(coinActions.orderUpdated(order, timestamp))
    })

    // This is a bit hacky. The intent is to move this logic server side,
    // so the presence of a snapshot/poll loop is invisible to the client.
    // In the meantime, I'm not polluting the reducer with it.
    socketClient.onOrdersSnapshot((coin, orders, timestamp) => {
      if (sameCoin(coin, selectedCoin())) {
        var idsPresent = []
        if (orders.length === 0) {
          // Update that there are no orders
          props.store.dispatch(coinActions.orderUpdated(null, timestamp))
        } else {
          // Updates for every order mentioned
          orders.forEach(o => {
            idsPresent.push(o.id)
            props.store.dispatch(coinActions.orderUpdated(o, timestamp))
          })
        }

        // Any order not mentioned should be removed
        if (props.store.getState().coin.orders) {
          props.store
            .getState()
            .coin.orders.filter(o => !idsPresent.includes(o.id))
            .forEach(o => {
              props.store.dispatch(
                coinActions.orderUpdated(
                  { id: o.id, status: "CANCELED" },
                  timestamp
                )
              )
            })
        }
      }
    })
  }, [props.store, selectedCoin])

  // Sync the state of the socket with the socket itself
  useEffect(() => {
    socketClient.onConnectionStateChange(newState => {
      setConnected((prevState: boolean) => {
        if (prevState !== newState) {
          if (newState) {
            props.store.dispatch(
              notificationActions.localMessage("Socket connected")
            )
            resubscribe()
          } else {
            props.store.dispatch(
              notificationActions.localMessage("Socket disconnected")
            )
          }
        }
        return newState
      })
    })
  }, [setConnected, props.store, resubscribe])

  // Connect the socket when authorised, and disconnect when deauthorised
  useEffect(() => {
    if (auth.authorised) {
      socketClient.connect()
    }
    return () => socketClient.disconnect()
  }, [auth.authorised])

  const api: SocketApi = useMemo(() => ({ connected, resubscribe }), [
    connected,
    resubscribe
  ])

  return (
    <SocketContext.Provider value={api}>
      {props.children}
    </SocketContext.Provider>
  )
}

export default Socket
export * from "./SocketContext"