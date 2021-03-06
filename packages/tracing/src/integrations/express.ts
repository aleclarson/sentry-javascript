/* eslint-disable @typescript-eslint/no-explicit-any */
import { Integration, Transaction } from '@sentry/types';
import { logger } from '@sentry/utils';

// Have to manually set types because we are using package-alias
type Method =
  | 'all'
  | 'get'
  | 'post'
  | 'put'
  | 'delete'
  | 'patch'
  | 'options'
  | 'head'
  | 'checkout'
  | 'copy'
  | 'lock'
  | 'merge'
  | 'mkactivity'
  | 'mkcol'
  | 'move'
  | 'm-search'
  | 'notify'
  | 'purge'
  | 'report'
  | 'search'
  | 'subscribe'
  | 'trace'
  | 'unlock'
  | 'unsubscribe';

type Application = {
  [method in Method | 'use']: (...args: any) => any;
};

type ErrorRequestHandler = (...args: any) => any;
type RequestHandler = (...args: any) => any;
type NextFunction = (...args: any) => any;

interface Response {
  once(name: string, callback: () => void): void;
}

/**
 * Internal helper for `__sentry_transaction`
 * @hidden
 */
interface SentryTracingResponse {
  __sentry_transaction?: Transaction;
}

/**
 * Express integration
 *
 * Provides an request and error handler for Express framework
 * as well as tracing capabilities
 */
export class Express implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'Express';

  /**
   * @inheritDoc
   */
  public name: string = Express.id;

  /**
   * Express App instance
   */
  private readonly _app?: Application;
  private readonly _methods?: Method[];

  /**
   * @inheritDoc
   */
  public constructor(options: { app?: Application; methods?: Method[] } = {}) {
    this._app = options.app;
    this._methods = options.methods;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    if (!this._app) {
      logger.error('ExpressIntegration is missing an Express instance');
      return;
    }
    instrumentMiddlewares(this._app);
    routeMiddlewares(this._app, this._methods);
  }
}

/**
 * Wraps original middleware function in a tracing call, which stores the info about the call as a span,
 * and finishes it once the middleware is done invoking.
 *
 * Express middlewares have 3 various forms, thus we have to take care of all of them:
 * // sync
 * app.use(function (req, res) { ... })
 * // async
 * app.use(function (req, res, next) { ... })
 * // error handler
 * app.use(function (err, req, res, next) { ... })
 */
// eslint-disable-next-line @typescript-eslint/ban-types
function wrap(fn: Function): RequestHandler | ErrorRequestHandler {
  const arity = fn.length;

  switch (arity) {
    case 2: {
      return function(this: NodeJS.Global, req: Request, res: Response & SentryTracingResponse): any {
        const transaction = res.__sentry_transaction;
        addExpressReqToTransaction(transaction, req);
        if (transaction) {
          const span = transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
          res.once('finish', () => {
            span.finish();
          });
        }
        // eslint-disable-next-line prefer-rest-params
        return fn.apply(this, arguments);
      };
    }
    case 3: {
      return function(
        this: NodeJS.Global,
        req: Request,
        res: Response & SentryTracingResponse,
        next: NextFunction,
      ): any {
        const transaction = res.__sentry_transaction;
        addExpressReqToTransaction(transaction, req);
        const span =
          transaction &&
          transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
        fn.call(this, req, res, function(this: NodeJS.Global): any {
          if (span) {
            span.finish();
          }
          // eslint-disable-next-line prefer-rest-params
          return next.apply(this, arguments);
        });
      };
    }
    case 4: {
      return function(
        this: NodeJS.Global,
        err: any,
        req: Request,
        res: Response & SentryTracingResponse,
        next: NextFunction,
      ): any {
        const transaction = res.__sentry_transaction;
        addExpressReqToTransaction(transaction, req);
        const span =
          transaction &&
          transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
        fn.call(this, err, req, res, function(this: NodeJS.Global): any {
          if (span) {
            span.finish();
          }
          // eslint-disable-next-line prefer-rest-params
          return next.apply(this, arguments);
        });
      };
    }
    default: {
      throw new Error(`Express middleware takes 2-4 arguments. Got: ${arity}`);
    }
  }
}

/**
 * Set parameterized as transaction name e.g.: `GET /users/:id`
 * Also adds more context data on the transaction from the request
 */
function addExpressReqToTransaction(transaction: Transaction | undefined, req: any): void {
  /* eslint-disable @typescript-eslint/no-unsafe-member-access */
  if (transaction) {
    if (req.route && req.route.path) {
      transaction.name = `${req.method} ${req.route.path}`;
    }
    transaction.setData('url', req.originalUrl);
    transaction.setData('baseUrl', req.baseUrl);
    transaction.setData('query', req.query);
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access */
}

/**
 * Takes all the function arguments passed to the original `app.use` call
 * and wraps every function, as well as array of functions with a call to our `wrap` method.
 * We have to take care of the arrays as well as iterate over all of the arguments,
 * as `app.use` can accept middlewares in few various forms.
 *
 * app.use([<path>], <fn>)
 * app.use([<path>], <fn>, ...<fn>)
 * app.use([<path>], ...<fn>[])
 */
function wrapUseArgs(args: IArguments): unknown[] {
  return Array.from(args).map((arg: unknown) => {
    if (typeof arg === 'function') {
      return wrap(arg);
    }

    if (Array.isArray(arg)) {
      return arg.map((a: unknown) => {
        if (typeof a === 'function') {
          return wrap(a);
        }
        return a;
      });
    }

    return arg;
  });
}

/**
 * Patches original App to utilize our tracing functionality
 */
function patchMiddleware(app: Application, method: Method | 'use'): Application {
  const originalAppCallback = app[method];

  app[method] = function(): any {
    // eslint-disable-next-line prefer-rest-params
    return originalAppCallback.apply(this, wrapUseArgs(arguments));
  };

  return app;
}

/**
 * Patches original app.use
 */
function instrumentMiddlewares(app: Application): void {
  patchMiddleware(app, 'use');
}

/**
 * Patches original app.METHOD
 */
function routeMiddlewares(app: Application, methods: Method[] = []): void {
  methods.forEach(function(method: Method) {
    patchMiddleware(app, method);
  });
}
