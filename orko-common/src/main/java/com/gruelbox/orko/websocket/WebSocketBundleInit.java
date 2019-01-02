package com.gruelbox.orko.websocket;

/*-
 * ===============================================================================L
 * Orko Common
 * ================================================================================
 * Copyright (C) 2018 - 2019 Graham Crockford
 * ================================================================================
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * ===============================================================================E
 */

import javax.websocket.server.ServerEndpointConfig;

import com.google.inject.Inject;
import com.google.inject.Injector;

import io.dropwizard.websockets.WebsocketBundle;

public class WebSocketBundleInit {

  private final Injector injector;

  @Inject
  WebSocketBundleInit(Injector injector) {
    this.injector = injector;
  }

  public void init(WebsocketBundle websocketBundle) {
    final ServerEndpointConfig config = ServerEndpointConfig.Builder
        .create(OrkoWebSocketServer.class, WebSocketModule.ENTRY_POINT)
        .build();
    config.getUserProperties().put(Injector.class.getName(), injector);
    websocketBundle.addEndpoint(config);
  }
}
