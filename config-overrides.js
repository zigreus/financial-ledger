module.exports = {
  webpack: function override(config) {
    config.resolve.fallback = {
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },

  devServer: function (configFunction) {
    return function (proxy, allowedHost) {
      const config = configFunction(proxy, allowedHost);

      // react-scripts 5.x가 생성하는 deprecated 옵션을 새 API로 교체
      const { onBeforeSetupMiddleware, onAfterSetupMiddleware, ...rest } = config;
      if (onBeforeSetupMiddleware || onAfterSetupMiddleware) {
        rest.setupMiddlewares = (middlewares, devServer) => {
          if (onBeforeSetupMiddleware) onBeforeSetupMiddleware(devServer);
          if (onAfterSetupMiddleware) onAfterSetupMiddleware(devServer);
          return middlewares;
        };
      }

      return rest;
    };
  },
};
