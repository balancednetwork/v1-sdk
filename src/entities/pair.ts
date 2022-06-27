import { getCreate2Address } from '@ethersproject/address';
import { pack, keccak256 } from '@ethersproject/solidity';
import JSBI from 'jsbi';
import invariant from 'tiny-invariant';

import { BigintIsh, Price, sqrt, Token, CurrencyAmount } from '@balancednetwork/sdk-core';

import {
  FACTORY_ADDRESS,
  INIT_CODE_HASH,
  MINIMUM_LIQUIDITY,
  FIVE,
  _997,
  _1000,
  ONE,
  ZERO,
  _99,
  _100,
  NULL_CONTRACT_ADDRESS,
} from '../constants';
import { InsufficientReservesError, InsufficientInputAmountError } from '../errors';

export const computePairAddress = ({
  factoryAddress,
  tokenA,
  tokenB,
}: {
  factoryAddress: string;
  tokenA: Token;
  tokenB: Token;
}): string => {
  const [token0, token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]; // does safety checks
  return getCreate2Address(
    factoryAddress,
    keccak256(['bytes'], [pack(['address', 'address'], [token0.address, token1.address])]),
    INIT_CODE_HASH,
  );
};
export class Pair {
  public readonly liquidityToken: Token;
  private readonly tokenAmounts: [CurrencyAmount<Token>, CurrencyAmount<Token>];

  public readonly poolId?: number;
  public readonly totalSupply?: CurrencyAmount<Token>;
  public readonly baseAddress?: string;

  public static getAddress(tokenA: Token, tokenB: Token): string {
    return computePairAddress({ factoryAddress: FACTORY_ADDRESS, tokenA, tokenB });
  }

  public constructor(
    currencyAmountA: CurrencyAmount<Token>,
    tokenAmountB: CurrencyAmount<Token>,
    additionalArgs?: {
      poolId?: number;
      totalSupply?: string;
      baseAddress?: string;
    },
  ) {
    const tokenAmounts = currencyAmountA.currency.sortsBefore(tokenAmountB.currency) // does safety checks
      ? [currencyAmountA, tokenAmountB]
      : [tokenAmountB, currencyAmountA];
    const tokenADecimals = tokenAmounts[0].currency.decimals;
    const tokenBDecimals = tokenAmounts[1].currency.decimals;
    const decimals = tokenADecimals !== tokenBDecimals ? (tokenADecimals + tokenBDecimals) / 2 : tokenADecimals;
    this.liquidityToken = new Token(
      tokenAmounts[0].currency.chainId,
      // Pair.getAddress(tokenAmounts[0].currency, tokenAmounts[1].currency),
      'cx0000000000000000000000000000000000000002',
      decimals,
      'BALN-V2',
      'Balanced V2',
    );
    this.tokenAmounts = tokenAmounts as [CurrencyAmount<Token>, CurrencyAmount<Token>];

    if (additionalArgs) {
      this.poolId = additionalArgs.poolId;
      this.totalSupply = CurrencyAmount.fromRawAmount(this.liquidityToken, additionalArgs.totalSupply || '0');
      this.baseAddress = additionalArgs.baseAddress;
    }
  }

  /**
   * Returns true if the token is either token0 or token1
   * @param token to check
   */
  public involvesToken(token: Token): boolean {
    return token.equals(this.token0) || token.equals(this.token1);
  }

  /**
   * Returns the current mid price of the pair in terms of token0, i.e. the ratio of reserve1 to reserve0
   */
  public get token0Price(): Price<Token, Token> {
    const result = this.tokenAmounts[1].divide(this.tokenAmounts[0]);
    return new Price(this.token0, this.token1, result.denominator, result.numerator);
  }

  /**
   * Returns the current mid price of the pair in terms of token1, i.e. the ratio of reserve0 to reserve1
   */
  public get token1Price(): Price<Token, Token> {
    const result = this.tokenAmounts[0].divide(this.tokenAmounts[1]);
    return new Price(this.token1, this.token0, result.denominator, result.numerator);
  }

  /**
   * Return the price of the given token in terms of the other token in the pair.
   * @param token token to return price of
   */
  public priceOf(token: Token): Price<Token, Token> {
    invariant(this.involvesToken(token), 'TOKEN');
    return token.equals(this.token0) ? this.token0Price : this.token1Price;
  }

  /**
   * Returns the chain ID of the tokens in the pair.
   */
  public get chainId(): number {
    return this.token0.chainId;
  }

  public get token0(): Token {
    return this.tokenAmounts[0].currency;
  }

  public get token1(): Token {
    return this.tokenAmounts[1].currency;
  }

  public get reserve0(): CurrencyAmount<Token> {
    return this.tokenAmounts[0];
  }

  public get reserve1(): CurrencyAmount<Token> {
    return this.tokenAmounts[1];
  }

  public get isQueue(): boolean {
    return (
      this.tokenAmounts[0].currency.address === NULL_CONTRACT_ADDRESS ||
      this.tokenAmounts[1].currency.address === NULL_CONTRACT_ADDRESS
    );
  }

  public reserveOf(token: Token): CurrencyAmount<Token> {
    invariant(this.involvesToken(token), 'TOKEN');
    return token.equals(this.token0) ? this.reserve0 : this.reserve1;
  }

  public getOutputAmount(inputAmount: CurrencyAmount<Token>): [CurrencyAmount<Token>, Pair] {
    invariant(this.involvesToken(inputAmount.currency), 'TOKEN');
    if (JSBI.equal(this.reserve0.quotient, ZERO) || JSBI.equal(this.reserve1.quotient, ZERO)) {
      throw new InsufficientReservesError();
    }

    const inputReserve = this.reserveOf(inputAmount.currency);
    const outputReserve = this.reserveOf(inputAmount.currency.equals(this.token0) ? this.token1 : this.token0);

    if (this.isQueue) {
      if (inputAmount.currency.address === NULL_CONTRACT_ADDRESS) {
        // ICX -> sICX
        const numerator = JSBI.multiply(inputAmount.numerator, outputReserve.quotient);
        const denominator = JSBI.multiply(inputAmount.denominator, inputReserve.quotient);
        const outputAmount = CurrencyAmount.fromRawAmount(outputReserve.currency, JSBI.divide(numerator, denominator));
        return [outputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
      } else {
        const numerator = JSBI.multiply(JSBI.multiply(inputAmount.numerator, _99), outputReserve.quotient);
        const denominator = JSBI.multiply(JSBI.multiply(inputAmount.denominator, _100), inputReserve.quotient);
        const outputAmount = CurrencyAmount.fromRawAmount(outputReserve.currency, JSBI.divide(numerator, denominator));
        return [outputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
      }
    }

    const inputAmountWithFee = JSBI.multiply(inputAmount.quotient, _997);
    const numerator = JSBI.multiply(inputAmountWithFee, outputReserve.quotient);
    const denominator = JSBI.add(JSBI.multiply(inputReserve.quotient, _1000), inputAmountWithFee);
    const outputAmount = CurrencyAmount.fromRawAmount(
      inputAmount.currency.equals(this.token0) ? this.token1 : this.token0,
      JSBI.divide(numerator, denominator),
    );
    if (JSBI.equal(outputAmount.quotient, ZERO)) {
      throw new InsufficientInputAmountError();
    }
    return [outputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
  }

  public getInputAmount(outputAmount: CurrencyAmount<Token>): [CurrencyAmount<Token>, Pair] {
    invariant(this.involvesToken(outputAmount.currency), 'TOKEN');
    if (
      JSBI.equal(this.reserve0.quotient, ZERO) ||
      JSBI.equal(this.reserve1.quotient, ZERO) ||
      JSBI.greaterThanOrEqual(outputAmount.quotient, this.reserveOf(outputAmount.currency).quotient)
    ) {
      throw new InsufficientReservesError();
    }

    const outputReserve = this.reserveOf(outputAmount.currency);
    const inputReserve = this.reserveOf(outputAmount.currency.equals(this.token0) ? this.token1 : this.token0);

    if (this.isQueue) {
      if (outputAmount.currency.address === NULL_CONTRACT_ADDRESS) {
        // sICX -> ICX
        const numerator = JSBI.multiply(JSBI.multiply(outputAmount.numerator, _100), inputReserve.quotient);
        const denominator = JSBI.multiply(JSBI.multiply(outputAmount.denominator, _99), outputReserve.quotient);
        const inputAmount = CurrencyAmount.fromRawAmount(inputReserve.currency, JSBI.divide(numerator, denominator));
        return [inputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
      } else {
        const numerator = JSBI.multiply(outputAmount.numerator, inputReserve.quotient);
        const denominator = JSBI.multiply(outputAmount.denominator, outputReserve.quotient);
        const inputAmount = CurrencyAmount.fromRawAmount(inputReserve.currency, JSBI.divide(numerator, denominator));
        return [inputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
      }
    }

    const numerator = JSBI.multiply(JSBI.multiply(inputReserve.quotient, outputAmount.quotient), _1000);
    const denominator = JSBI.multiply(JSBI.subtract(outputReserve.quotient, outputAmount.quotient), _997);
    const inputAmount = CurrencyAmount.fromRawAmount(
      outputAmount.currency.equals(this.token0) ? this.token1 : this.token0,
      JSBI.add(JSBI.divide(numerator, denominator), ONE),
    );
    return [inputAmount, new Pair(inputReserve.add(inputAmount), outputReserve.subtract(outputAmount), {})];
  }

  public getLiquidityMinted(
    totalSupply: CurrencyAmount<Token>,
    tokenAmountA: CurrencyAmount<Token>,
    tokenAmountB: CurrencyAmount<Token>,
  ): CurrencyAmount<Token> {
    invariant(totalSupply.currency.equals(this.liquidityToken), 'LIQUIDITY');
    const tokenAmounts = tokenAmountA.currency.sortsBefore(tokenAmountB.currency) // does safety checks
      ? [tokenAmountA, tokenAmountB]
      : [tokenAmountB, tokenAmountA];
    invariant(tokenAmounts[0].currency.equals(this.token0) && tokenAmounts[1].currency.equals(this.token1), 'TOKEN');

    let liquidity: JSBI;

    // when the pair is queue, return ICX amount
    if (this.isQueue) {
      return CurrencyAmount.fromRawAmount(
        this.liquidityToken,
        tokenAmountA.currency.address === NULL_CONTRACT_ADDRESS ? tokenAmountA.quotient : tokenAmountB.quotient,
      );
    }

    if (JSBI.equal(totalSupply.quotient, ZERO)) {
      liquidity = JSBI.subtract(
        sqrt(JSBI.multiply(tokenAmounts[0].quotient, tokenAmounts[1].quotient)),
        MINIMUM_LIQUIDITY,
      );
    } else {
      const amount0 = JSBI.divide(
        JSBI.multiply(tokenAmounts[0].quotient, totalSupply.quotient),
        this.reserve0.quotient,
      );
      const amount1 = JSBI.divide(
        JSBI.multiply(tokenAmounts[1].quotient, totalSupply.quotient),
        this.reserve1.quotient,
      );
      liquidity = JSBI.lessThanOrEqual(amount0, amount1) ? amount0 : amount1;
    }
    if (!JSBI.greaterThan(liquidity, ZERO)) {
      throw new InsufficientInputAmountError();
    }
    return CurrencyAmount.fromRawAmount(this.liquidityToken, liquidity);
  }

  public getLiquidityValue(
    token: Token,
    totalSupply: CurrencyAmount<Token>,
    liquidity: CurrencyAmount<Token>,
    feeOn: boolean = false,
    kLast?: BigintIsh,
  ): CurrencyAmount<Token> {
    invariant(this.involvesToken(token), 'TOKEN');
    invariant(totalSupply.currency.equals(this.liquidityToken), 'TOTAL_SUPPLY');
    invariant(liquidity.currency.equals(this.liquidityToken), 'LIQUIDITY');
    invariant(JSBI.lessThanOrEqual(liquidity.quotient, totalSupply.quotient), 'LIQUIDITY');

    let totalSupplyAdjusted: CurrencyAmount<Token>;
    if (!feeOn) {
      totalSupplyAdjusted = totalSupply;
    } else {
      invariant(!!kLast, 'K_LAST');
      const kLastParsed = JSBI.BigInt(kLast);
      if (!JSBI.equal(kLastParsed, ZERO)) {
        const rootK = sqrt(JSBI.multiply(this.reserve0.quotient, this.reserve1.quotient));
        const rootKLast = sqrt(kLastParsed);
        if (JSBI.greaterThan(rootK, rootKLast)) {
          const numerator = JSBI.multiply(totalSupply.quotient, JSBI.subtract(rootK, rootKLast));
          const denominator = JSBI.add(JSBI.multiply(rootK, FIVE), rootKLast);
          const feeLiquidity = JSBI.divide(numerator, denominator);
          totalSupplyAdjusted = totalSupply.add(CurrencyAmount.fromRawAmount(this.liquidityToken, feeLiquidity));
        } else {
          totalSupplyAdjusted = totalSupply;
        }
      } else {
        totalSupplyAdjusted = totalSupply;
      }
    }

    return CurrencyAmount.fromRawAmount(
      token,
      JSBI.divide(JSBI.multiply(liquidity.quotient, this.reserveOf(token).quotient), totalSupplyAdjusted.quotient),
    );
  }
}
