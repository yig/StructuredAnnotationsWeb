// Dense linear algebra.  The systems in this program are small (one row per spine vertex),
// so a dense LU decomposition with partial pivoting (what numpy.linalg.solve() does) suffices.

export class Matrix {
    readonly data: Float64Array;
    constructor( readonly rows: number, readonly cols: number, data?: Float64Array ) {
        this.data = data ?? new Float64Array( rows * cols );
    }
    get( i: number, j: number ): number { return this.data[ i * this.cols + j ]; }
    set( i: number, j: number, v: number ): void { this.data[ i * this.cols + j ] = v; }
    addTo( i: number, j: number, v: number ): void { this.data[ i * this.cols + j ] += v; }
    clone(): Matrix { return new Matrix( this.rows, this.cols, this.data.slice() ); }
    // Replaces row 'i' with the i-th row of the identity matrix.
    setIdentityRow( i: number ): void {
        this.data.fill( 0, i * this.cols, ( i + 1 ) * this.cols );
        this.set( i, i, 1 );
    }
}

// An LU decomposition with partial pivoting of a square matrix, reusable for several right-hand sides.
export class LU {
    private readonly lu: Float64Array;
    private readonly perm: Int32Array;
    readonly n: number;

    constructor( A: Matrix ) {
        if( A.rows !== A.cols ) throw new Error( 'LU: matrix must be square' );
        const n = this.n = A.rows;
        const lu = this.lu = A.data.slice();
        const perm = this.perm = new Int32Array( n );
        for( let i = 0; i < n; ++i ) perm[i] = i;

        for( let k = 0; k < n; ++k ) {
            // Choose the pivot.
            let p = k;
            let maxAbs = Math.abs( lu[ k * n + k ] );
            for( let i = k + 1; i < n; ++i ) {
                const v = Math.abs( lu[ i * n + k ] );
                if( v > maxAbs ) { maxAbs = v; p = i; }
            }
            if( maxAbs === 0 ) throw new Error( 'LU: singular matrix' );
            if( p !== k ) {
                for( let j = 0; j < n; ++j ) {
                    const tmp = lu[ k * n + j ]; lu[ k * n + j ] = lu[ p * n + j ]; lu[ p * n + j ] = tmp;
                }
                const tmp = perm[k]; perm[k] = perm[p]; perm[p] = tmp;
            }
            const pivot = lu[ k * n + k ];
            for( let i = k + 1; i < n; ++i ) {
                const f = lu[ i * n + k ] / pivot;
                if( f === 0 ) continue;
                lu[ i * n + k ] = f;
                for( let j = k + 1; j < n; ++j ) lu[ i * n + j ] -= f * lu[ k * n + j ];
            }
        }
    }

    // Solves A x = b for a single right-hand side.
    solve( b: ArrayLike<number> ): Float64Array {
        const { n, lu, perm } = this;
        const x = new Float64Array( n );
        for( let i = 0; i < n; ++i ) x[i] = b[ perm[i] ];
        for( let i = 0; i < n; ++i ) {
            let s = x[i];
            for( let j = 0; j < i; ++j ) s -= lu[ i * n + j ] * x[j];
            x[i] = s;
        }
        for( let i = n - 1; i >= 0; --i ) {
            let s = x[i];
            for( let j = i + 1; j < n; ++j ) s -= lu[ i * n + j ] * x[j];
            x[i] = s / lu[ i * n + i ];
        }
        return x;
    }
}

export function solve( A: Matrix, b: ArrayLike<number> ): Float64Array {
    return new LU( A ).solve( b );
}

// Minimizes .5 |x - b|^2 subject to the hard linear constraints C x = d (one row of C per constraint).
// This is what mymath.solve_system_with_constraints( identity, b, linear_constraints, 'hard' )
// computes in the original implementation: x = b - C^T ( C C^T )^{-1} ( C b - d ).
export function closestPointSatisfyingConstraints( b: number[], C: number[][], d: number[] ): number[] {
    const m = C.length;
    const CCt = new Matrix( m, m );
    for( let i = 0; i < m; ++i ) for( let j = 0; j < m; ++j ) {
        let s = 0;
        for( let k = 0; k < b.length; ++k ) s += C[i][k] * C[j][k];
        CCt.set( i, j, s );
    }
    const residual = C.map( ( row, i ) => row.reduce( ( s, c, k ) => s + c * b[k], 0 ) - d[i] );
    const lambda = solve( CCt, residual );
    return b.map( ( bk, k ) => bk - C.reduce( ( s, row, i ) => s + row[k] * lambda[i], 0 ) );
}
