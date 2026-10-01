/** Adapted from ui-theme FontSizeRow.tsx; MIT copyright retained. */
import { ChevronDown, ChevronUp } from 'lucide-react'
import css from './FontSizeRow.module.css'

export function FontSizeRow({ value, onChange, labels }: { value:number; onChange:(value:number)=>void; labels:{title:string;description:string;increase:string;decrease:string;unit:string} }) {
  return <div className={css.row}><div className={css.rowText}><div className={css.title}>{labels.title}</div><div className={css.desc}>{labels.description}</div></div><div className={css.control}><div className={css.stepper}><span className={css.value}>{value}</span><span className={css.arrows}><button type="button" className={css.arrow} aria-label={labels.increase} disabled={value>=18} onClick={()=>onChange(Math.min(18,value+1))}><ChevronUp size={10}/></button><button type="button" className={css.arrow} aria-label={labels.decrease} disabled={value<=12} onClick={()=>onChange(Math.max(12,value-1))}><ChevronDown size={10}/></button></span></div><span className={css.unit}>{labels.unit}</span></div></div>
}
